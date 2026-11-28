import { Button, Form, Input, Label, Switch, TextField } from '@heroui/react';
import { useState } from 'react';
import { call, codeOf, problem } from './api';
import type { Launchable, Team, TeamRole } from './api';
import { ApplicationManager, AuditTable, UnlockChanges, teamLabel, useRoles, useTeams } from './shared';
import { Choice, ConfirmButton, Empty, Loaded, Notice, PageLink, Panel, Secret, State, TaskFeedback, readForm, useApp, useLoad, useTask, useTime } from './ui';

type Member = { id: string; email: string; name: string | null; role: TeamRole; enabled: boolean; joinedAt: string };
type Pending = { id: string; email: string; role: TeamRole; createdAt: string; expiresAt: string };
type Detail = { org: Omit<Team, 'members'>; members: Member[]; invitations: Pending[] };
type Reload = () => Promise<void>;

// The pages of one team. Members see who is in it. Owners and admins also run it from here.
export function TeamArea({ id, page }: { id: string; page: string | undefined }) {
  const { t, language, account } = useApp();
  const base = `/account/orgs/${encodeURIComponent(id)}`;
  const detail = useLoad(() => call<Detail>(base), 'team:' + id);
  if (detail.error && codeOf(detail.error) === 'team_not_found') {
    return <><Notice status="danger">{problem(detail.error, language)}</Notice>
      <div><PageLink to={{ section: 'workspace', tab: 'teams' }}>{t('All teams', '全部团队')}</PageLink></div></>;
  }
  return <Loaded source={detail}>{data => {
    const { org } = data;
    const manages = !org.personal && org.role !== 'member';
    if (!page) return <Members base={base} detail={data} reload={detail.reload} manages={manages} />;
    if (!manages) return <Notice status="default">{problem('team_role_required', language)}</Notice>;
    // A team that asks for a second factor asks its own administrators first.
    const locked = org.requireSecondFactor && !account?.secondFactorVerified;
    if (locked) return <UnlockChanges />;
    if (page === 'applications') return <><UnlockChanges /><ApplicationManager key={String(account?.secondFactorVerified)} base={base + '/applications'}
      canWrite={Boolean(account?.secondFactorVerified)} removable /></>;
    if (page === 'tokens') return <Tokens base={base} team={id} />;
    if (page === 'audit') return <AuditTable source={base + '/audit'} />;
    return <Settings base={base} detail={data} reload={detail.reload} />;
  }}</Loaded>;
}

function Members({ base, detail: { org, members: people, invitations }, reload, manages }: { base: string; detail: Detail; reload: Reload; manages: boolean }) {
  const { t, language, navigate, account } = useApp();
  const teams = useTeams();
  const roles = useRoles();
  const time = useTime();
  const members = useTask();
  const inviting = useTask();
  const [inviteRole, setInviteRole] = useState('member');
  const [issued, setIssued] = useState<{ email: string; link: string; delivered: boolean }>();
  const owners = people.filter(person => person.role === 'owner').length;
  const soleOwner = org.role === 'owner' && owners === 1;
  // Nobody hands out more than they hold: an admin moves people between member and admin,
  // and only an owner makes, unmakes or changes an owner.
  const assignable = (person: Member): TeamRole[] => org.role === 'owner' ? ['owner', 'admin', 'member']
    : org.role === 'admin' && person.role !== 'owner' ? ['admin', 'member'] : [];
  return <>
    <Panel>
      <TaskFeedback task={members} />
      {soleOwner && people.length > 1 && <Empty>{t('You are the only owner. Make someone else an owner before you leave or change your role.',
        '你是唯一的所有者。离开团队或更改自己的角色前，请先将其他成员设为所有者。')}</Empty>}
      <ul className="grid divide-y divide-separator">
        {people.map(person => {
          const self = person.id === account?.id;
          const lastOwner = person.role === 'owner' && owners === 1;
          const removable = !org.personal && !self && manages && (person.role !== 'owner' || org.role === 'owner');
          const options = org.personal ? [] : assignable(person);
          return <li key={person.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0" data-member={person.email}>
            <div className="grid min-w-0 gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium wrap-anywhere">{person.name ?? person.email}</span>
                {self && <State color="accent">{t('You', '你')}</State>}
                {!person.enabled && <State color="danger">{t('Disabled', '已停用')}</State>}
                {!options.length && <State>{roles[person.role]}</State>}
              </div>
              {person.name && <p className="text-sm text-muted wrap-anywhere">{person.email}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {options.length > 0 && <Choice hideLabel className="w-36" label={t(`Role of ${person.email}`, `${person.email} 的角色`)} value={person.role}
                onChange={role => void members.run('role', async () => {
                  await call(`${base}/members/${encodeURIComponent(person.id)}/role`, { role });
                  await Promise.all([reload(), teams.reload()]);
                })} options={options.map(role => ({ id: role, label: roles[role] }))} />}
              {removable && <ConfirmButton label={t('Remove', '移除')} confirm={t('Confirm removal', '确认移除')} pending={members.pending === person.id}
                onConfirm={() => void members.run(person.id, async () => {
                  await call(`${base}/members/${encodeURIComponent(person.id)}/remove`, {});
                  await Promise.all([reload(), teams.reload()]);
                })} />}
              {self && !org.personal && <ConfirmButton label={t('Leave team', '离开团队')} confirm={t('Confirm leaving', '确认离开')} isDisabled={lastOwner && people.length > 1}
                pending={members.pending === person.id} onConfirm={() => void members.run(person.id, async () => {
                  await call(`${base}/members/${encodeURIComponent(person.id)}/remove`, {});
                  await teams.reload();
                  navigate({ language, section: 'workspace', tab: 'teams' }, true);
                })} />}
            </div>
          </li>;
        })}
      </ul>
    </Panel>
    {manages && <Panel title={t('Invite people', '邀请成员')} description={t('Invitations work for 7 days and only for the invited address.', '邀请 7 天内有效，且只对受邀邮箱有效。')}>
      <TaskFeedback task={inviting} />
      <Form className="flex flex-wrap items-end gap-3" validationBehavior="native" onSubmit={event => {
        const email = readForm(event)('email').trim();
        const form = event.currentTarget;
        void inviting.run('invite', async () => {
          const sent = await call<{ email: string; link: string; delivered: boolean }>(base + '/invitations', { email, role: inviteRole });
          setIssued(sent);
          form.reset();
          await reload();
        });
      }}>
        <TextField name="email" type="email" isRequired className="min-w-0 flex-1 basis-56">
          <Label>{t('Email', '邮箱')}</Label><Input className="w-full min-w-0" autoComplete="off" />
        </TextField>
        <Choice className="w-36" label={t('Role', '角色')} value={inviteRole} onChange={setInviteRole}
          options={[{ id: 'member', label: roles.member }, { id: 'admin', label: roles.admin }]} />
        <Button type="submit" isPending={inviting.pending === 'invite'}>{t('Invite', '邀请')}</Button>
      </Form>
      {issued && <Secret title={issued.delivered ? t(`We emailed the invitation to ${issued.email}.`, `邀请邮件已发送到 ${issued.email}。`)
        : t(`No email was sent. Pass this link to ${issued.email} yourself.`, `未发送邮件。请自行把这个链接发给 ${issued.email}。`)}
        note={t('The link is shown only this once.', '链接只在此处显示一次。')} onDone={() => setIssued(undefined)}
        values={[{ label: t('Invitation link', '邀请链接'), value: issued.link, name: 'invitation-link' }]} />}
      {invitations.length > 0 && <div className="grid gap-2">
        <h3 className="text-sm font-medium">{t('Waiting for a reply', '等待回应')}</h3>
        <ul className="grid divide-y divide-separator">
          {invitations.map(pending => <li key={pending.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
            <div className="grid min-w-0 gap-1">
              <div className="flex flex-wrap items-center gap-2"><span className="wrap-anywhere">{pending.email}</span><State>{roles[pending.role]}</State></div>
              <p className="text-sm text-muted">{t(`Expires ${time(pending.expiresAt)}`, `${time(pending.expiresAt)} 过期`)}</p>
            </div>
            <Button size="sm" variant="secondary" isPending={inviting.pending === pending.id} onPress={() => void inviting.run(pending.id, async () => {
              await call(`${base}/invitations/${encodeURIComponent(pending.id)}/revoke`, {});
              await reload();
            })}>{t('Withdraw', '撤回')}</Button>
          </li>)}
        </ul>
      </div>}
    </Panel>}
  </>;
}

type TeamToken = {
  id: string; name: string; hint: string; kind: 'team' | 'member'; role: 'admin' | 'member' | null; appName: string;
  member: string | null; issuedBy: string | null; createdAt: string; expiresAt: string | null; lastUsedAt: string | null;
};

function Tokens({ base, team }: { base: string; team: string }) {
  const { t } = useApp();
  const roles = useRoles();
  const time = useTime();
  const task = useTask();
  const creating = useTask();
  const list = useLoad(() => call<{ tokens: TeamToken[] }>(base + '/tokens'), 'team-tokens:' + team);
  const apps = useLoad(() => call<{ applications: Launchable[] }>('/account/apps'), 'apps');
  const [app, setApp] = useState('');
  const [role, setRole] = useState('member');
  const [days, setDays] = useState('90');
  const [issued, setIssued] = useState<string>();
  // The team's own applications and the instance's. Another team's application is not a choice.
  const applications = (apps.data?.applications ?? []).filter(({ owner }) => owner.kind === 'instance' || owner.id === team);
  const chosenApp = applications.find(({ id }) => id === app) ?? applications[0];
  const row = (token: TeamToken) => <li key={token.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0" data-token={token.name}>
    <div className="grid min-w-0 gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium wrap-anywhere">{token.name} <span className="font-normal text-muted">…{token.hint}</span></span>
        {token.role && <State>{roles[token.role]}</State>}
      </div>
      <p className="text-sm text-muted wrap-anywhere">{[token.appName, token.kind === 'team'
        ? token.issuedBy && t(`created by ${token.issuedBy}`, `由 ${token.issuedBy} 创建`) : token.member].filter(Boolean).join(' · ')}</p>
      <p className="text-sm text-muted">{[t(`Created ${time(token.createdAt)}`, `创建于 ${time(token.createdAt)}`),
        token.expiresAt ? t(`expires ${time(token.expiresAt)}`, `${time(token.expiresAt)} 过期`) : t('no expiry', '不过期'),
        token.lastUsedAt ? t(`last used ${time(token.lastUsedAt)}`, `最近使用于 ${time(token.lastUsedAt)}`) : t('never used', '尚未使用')].join(' · ')}</p>
    </div>
    <ConfirmButton label={t('Revoke', '撤销')} confirm={t('Confirm revoke', '确认撤销')} pending={task.pending === token.id}
      onConfirm={() => void task.run(token.id, async () => {
        await call(`${base}/tokens/${encodeURIComponent(token.id)}/revoke`, {});
        await list.reload();
      })} />
  </li>;
  return <>
    <TaskFeedback task={task} />
    <Panel title={t('Team tokens', '团队令牌')}
      description={t('A team token acts as the team itself in one application. It keeps working when the person who created it leaves.', '团队令牌在一个应用中代表团队本身，创建者离开团队后仍然有效。')}>
      <Loaded source={list}>{({ tokens }) => {
        const own = tokens.filter(token => token.kind === 'team');
        return own.length ? <ul className="grid divide-y divide-separator">{own.map(row)}</ul> : <Empty>{t('No team tokens yet.', '还没有团队令牌。')}</Empty>;
      }}</Loaded>
    </Panel>
    <Panel title={t('Create a team token', '创建团队令牌')}>
      <TaskFeedback task={creating} />
      <Loaded source={apps}>{() => !chosenApp ? <Empty>{t('Tokens need a connected application. None is connected yet.', '令牌需要对应一个已接入的应用，目前还没有应用。')}</Empty>
        : <Form className="grid gap-4" validationBehavior="native" onSubmit={event => {
          const name = readForm(event)('name');
          const form = event.currentTarget;
          void creating.run('create', async () => {
            const created = await call<{ token: string }>(base + '/tokens', { name, app: chosenApp.id, role, days });
            setIssued(created.token);
            form.reset();
            await list.reload();
          });
        }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField name="name" isRequired><Label>{t('Name', '名称')}</Label><Input className="w-full min-w-0" maxLength={80} autoComplete="off" /></TextField>
            <Choice label={t('Application', '应用')} value={chosenApp.id} onChange={setApp} options={applications.map(({ id, name }) => ({ id, label: name }))} />
            <Choice label={t('Acts as', '身份')} value={role} onChange={setRole} options={[{ id: 'member', label: roles.member }, { id: 'admin', label: roles.admin }]} />
            <Choice label={t('Valid for', '有效期')} value={days} onChange={setDays}
              options={[7, 30, 90, 365].map(count => ({ id: String(count), label: t(`${count} days`, `${count} 天`) }))} />
          </div>
          <div><Button type="submit" isPending={creating.pending === 'create'}>{t('Create token', '创建令牌')}</Button></div>
        </Form>}</Loaded>
      {issued && <Secret title={t('Copy the new token now', '请立即复制新令牌')} note={t('It is shown only this once.', '令牌只在此处显示一次。')}
        onDone={() => setIssued(undefined)} values={[{ label: t('Token', '令牌'), value: issued, name: 'agent-token' }]} />}
    </Panel>
    <Panel title={t('Members’ tokens', '成员的令牌')} description={t('Personal tokens that members created for this team.', '成员为此团队创建的个人令牌。')}>
      <Loaded source={list}>{({ tokens }) => {
        const personal = tokens.filter(token => token.kind === 'member');
        return personal.length ? <ul className="grid divide-y divide-separator">{personal.map(row)}</ul> : <Empty>{t('No member has a token for this team.', '还没有成员为此团队创建令牌。')}</Empty>;
      }}</Loaded>
    </Panel>
  </>;
}

function Settings({ base, detail: { org, members }, reload }: { base: string; detail: Detail; reload: Reload }) {
  const { t, language, navigate, account } = useApp();
  const teams = useTeams();
  const naming = useTask();
  const security = useTask();
  const transfer = useTask();
  const removal = useTask();
  const others = members.filter(person => person.id !== account?.id);
  const [heir, setHeir] = useState('');
  const chosenHeir = others.find(({ id }) => id === heir)?.id ?? others[0]?.id ?? '';
  const owner = org.role === 'owner';
  return <>
    <Panel title={t('Team name', '团队名称')}>
      <TaskFeedback task={naming} />
      <Form className="flex max-w-md flex-wrap items-end gap-3" validationBehavior="native" onSubmit={event => {
        const name = readForm(event)('name');
        void naming.run('rename', async () => {
          await call(base + '/rename', { name });
          await Promise.all([reload(), teams.reload()]);
          return t('Team renamed.', '团队已重命名。');
        });
      }}>
        <TextField name="name" isRequired defaultValue={org.name} aria-label={t('Team name', '团队名称')} className="min-w-0 flex-1 basis-48">
          <Input className="w-full min-w-0" maxLength={80} />
        </TextField>
        <Button type="submit" variant="secondary" isPending={naming.pending === 'rename'}>{t('Rename', '重命名')}</Button>
      </Form>
    </Panel>
    <Panel title={t('Two-step verification', '两步验证')}
      description={t('When required, members confirm a code before they enter this team’s applications, and administrators before they manage the team.',
        '开启后，成员进入此团队的应用前需要输入验证码，管理员管理团队前也需要。')}>
      <TaskFeedback task={security} />
      {owner && !account?.secondFactorVerified && !org.requireSecondFactor && <UnlockChanges />}
      <Switch isSelected={org.requireSecondFactor} isDisabled={!owner || security.pending === 'save' || (!org.requireSecondFactor && !account?.secondFactorVerified)}
        onChange={required => void security.run('save', async () => {
          await call(base + '/security', { requireSecondFactor: String(required) });
          await Promise.all([reload(), teams.reload()]);
        })}>
        <Switch.Content>
          <Switch.Control><Switch.Thumb /></Switch.Control>
          <Label>{t('Require two-step verification', '要求两步验证')}</Label>
        </Switch.Content>
      </Switch>
      {!owner && <Empty>{problem('team_owner_required', language)}</Empty>}
    </Panel>
    {owner && <Panel title={t('Transfer ownership', '转让所有权')} description={t('The new owner takes over the team. You stay on as an admin.', '新所有者接管团队，你保留管理员身份。')}>
      <TaskFeedback task={transfer} />
      {others.length ? <div className="flex flex-wrap items-end gap-3">
        <Choice className="w-full max-w-xs" label={t('New owner', '新所有者')} value={chosenHeir} onChange={setHeir}
          options={others.map(person => ({ id: person.id, label: person.name ? `${person.name} · ${person.email}` : person.email }))} />
        <ConfirmButton size="md" label={t('Transfer', '转让')} confirm={t('Confirm transfer', '确认转让')} pending={transfer.pending === 'transfer'}
          onConfirm={() => void transfer.run('transfer', async () => {
            await call(base + '/transfer', { account: chosenHeir });
            await Promise.all([reload(), teams.reload()]);
            return t('Ownership transferred.', '所有权已转让。');
          })} />
      </div> : <Empty>{t('Invite someone first. A team is transferred to one of its members.', '请先邀请成员，团队只能转让给现有成员。')}</Empty>}
    </Panel>}
    {owner && <Panel title={t('Delete team', '删除团队')}
      description={t('This removes the team, its applications, its tokens and every membership. It cannot be undone.', '团队及其应用、令牌和全部成员关系都会被移除，且无法恢复。')}>
      <TaskFeedback task={removal} />
      <Form className="flex max-w-md flex-wrap items-end gap-3" validationBehavior="native" onSubmit={event => {
        const name = readForm(event)('name');
        void removal.run('delete', async () => {
          await call(base + '/delete', { name });
          await teams.reload();
          navigate({ language, section: 'workspace', tab: 'teams' }, true);
        });
      }}>
        <TextField name="name" isRequired className="min-w-0 flex-1 basis-48">
          <Label>{t(`Type “${teamLabel(org, t)}” to confirm`, `输入「${teamLabel(org, t)}」以确认`)}</Label>
          <Input className="w-full min-w-0" autoComplete="off" />
        </TextField>
        <Button type="submit" variant="danger" isPending={removal.pending === 'delete'}>{t('Delete team', '删除团队')}</Button>
      </Form>
    </Panel>}
  </>;
}
