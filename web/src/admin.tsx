import { Button, Chip, Dropdown, Form, Input, Label, Table, TextField } from '@heroui/react';
import Envelope from '@gravity-ui/icons/Envelope';
import House from '@gravity-ui/icons/House';
import LayoutCellsLarge from '@gravity-ui/icons/LayoutCellsLarge';
import ListUl from '@gravity-ui/icons/ListUl';
import Person from '@gravity-ui/icons/Person';
import Persons from '@gravity-ui/icons/Persons';
import { useState } from 'react';
import { RequestFailure, call, codeOf, problem } from './api';
import type { MailStatus, RegistrationPolicy, TeamApplicationPolicy } from './api';
import { adminPages, areas, pageOf } from './pages';
import { ApplicationManager, AuditTable, UnlockChanges } from './shared';
import { container, pathFor } from './site';
import type { Route } from './site';
import { MailSetup } from './setup';
import { SidebarLayout } from './sidebar-layout';
import { Choice, ConfirmButton, Empty, Loaded, Notice, PageLink, Panel, Secret, State, TaskFeedback, readForm, useApp, useLoad, useTask, useTime } from './ui';

type Overview = {
  counts: { accounts: number; teams: number; applications: number; deletionRequests: number };
  mail: MailStatus; registration: RegistrationPolicy; teamApplications: TeamApplicationPolicy;
  canWrite: boolean; secondFactorEnabled: boolean; role: 'owner' | 'admin';
};
type Console = { overview: Overview; reload: () => Promise<void> };

const icons = { overview: House, accounts: Person, teams: Persons, applications: LayoutCellsLarge, mail: Envelope, audit: ListUl };

export function Admin({ route }: { route: Route }) {
  const { t, language, account } = useApp();
  const overview = useLoad(() => call<Overview>('/admin/api/overview'), 'admin:' + (account?.instanceRole ?? '') + ':' + String(account?.secondFactorVerified));
  const title = t(...areas.admin);
  if (!account) return null;
  if (!account.instanceRole) {
    return <main className={`${container} flex-1 py-8 md:py-12`}><div className="grid max-w-xl gap-4">
      <h1 className="text-balance text-3xl font-semibold tracking-tight">{title}</h1>
      <Notice status="default">{problem('administrator_required', language)}</Notice>
      <PageLink to={{ section: 'workspace' }}>{t('Back to your account', '返回账号中心')}</PageLink>
    </div></main>;
  }
  const page = pageOf(route)!;
  const tab = page.id;
  const href = (id: string | undefined) => pathFor({ language, section: 'admin', tab: id });
  const groups = [{ id: 'console', items: adminPages.map(entry => ({
    id: entry.id ?? 'overview', label: t(entry.en, entry.zh), icon: icons[entry.id ?? 'overview'], href: href(entry.id) })) }];
  const state = overview.data;
  const console: Console | undefined = state && { overview: state, reload: overview.reload };
  const banner = state && (state.mail.source === 'none' || !state.canWrite) && <div className="grid gap-3">
    {state.mail.source === 'none' && <Notice status="warning" action={tab !== 'mail' && <PageLink to={{ section: 'admin', tab: 'mail' }}>{t('Set up outgoing mail', '配置发信')}</PageLink>}>
      {t('Outgoing mail is not configured. New accounts stay unverified and people cannot reset their own passwords.', '未配置发信。新账号的邮箱保持未验证，用户也无法自行重置密码。')}
    </Notice>}
    {!state.canWrite && <UnlockChanges onUnlocked={overview.reload} />}
  </div>;
  return <SidebarLayout title={title} navigation={t('Instance console navigation', '实例管理台导航')}
    openNavigation={t('Open instance console navigation', '打开实例管理台导航')} route={route} groups={groups} activeHref={href(tab)} account={account}>
    <div className="grid justify-items-start gap-2">
      <Chip size="sm" variant="soft" color="accent" className="sm:hidden"><Chip.Label>{title}</Chip.Label></Chip>
      <h1 className="text-balance text-3xl font-semibold tracking-tight">{t(page.en, page.zh)}</h1>
    </div>
    {banner}
    <Loaded source={overview}>{() => console ? (!tab ? <Summary console={console} /> : tab === 'accounts' ? <Accounts console={console} />
      : tab === 'teams' ? <AllTeams /> : tab === 'applications' ? <Applications console={console} /> : tab === 'mail' ? <Mail console={console} />
      : <AuditTable source="/admin/api/audit" />) : null}</Loaded>
  </SidebarLayout>;
}

function Summary({ console: { overview, reload } }: { console: Console }) {
  const { t } = useApp();
  const task = useTask();
  const counts = [
    [t('Accounts', '账号'), overview.counts.accounts], [t('Teams', '团队'), overview.counts.teams],
    [t('Applications', '应用'), overview.counts.applications], [t('Deletion requests', '删除申请'), overview.counts.deletionRequests],
  ] as const;
  const registrationDescription = {
    open: t('Anyone can create an account.', '任何人都可以创建账号。'),
    invite: t('Only people with a team invitation can create an account.', '只有收到团队邀请的人可以创建账号。'),
    closed: t('New account registration is closed.', '已关闭新账号注册。'),
  };
  return <>
    <Panel title={t('This instance', '实例概况')} aside={<State>{overview.role === 'owner' ? t('You are the owner', '你是所有者') : t('You are an administrator', '你是管理员')}</State>}>
      <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {counts.map(([label, value]) => <div key={label}><dt className="text-sm text-muted">{label}</dt><dd className="text-2xl font-semibold tabular-nums">{value}</dd></div>)}
      </dl>
    </Panel>
    <Panel title={t('Registration', '注册')} description={registrationDescription[overview.registration]}>
      <TaskFeedback task={task} />
      <Choice className="w-full max-w-xs" label={t('Who can register', '谁可以注册')} value={overview.registration} isDisabled={!overview.canWrite}
        onChange={policy => void task.run('policy', async () => {
          await call('/admin/api/registration', { policy });
          await reload();
          return t('Registration setting saved.', '注册设置已保存。');
        })} options={[
          { id: 'open', label: t('Open to everyone', '对所有人开放') },
          { id: 'invite', label: t('Invite-only', '仅限受邀') },
          { id: 'closed', label: t('Closed', '关闭注册') },
        ]} />
    </Panel>
  </>;
}

type Listed = {
  id: string; email: string; name: string | null; enabled: boolean; emailVerified: boolean; instanceRole: 'owner' | 'admin' | null;
  secondFactorEnabled: boolean; createdAt: string; deletionRequestedAt: string | null;
};

function Accounts({ console: { overview, reload } }: { console: Console }) {
  const { t, language, account: viewer } = useApp();
  const time = useTime();
  const task = useTask();
  const [query, setQuery] = useState('');
  const [deleting, setDeleting] = useState<string>();
  const [link, setLink] = useState<{ email: string; link: string }>();
  const list = useLoad(() => call<{ accounts: Listed[] }>('/admin/api/accounts' + (query ? '?q=' + encodeURIComponent(query) : '')), 'accounts:' + query);
  const act = (key: string, work: () => Promise<string | void>) => void task.run(key, async () => {
    const done = await work();
    await Promise.all([list.reload(), reload()]);
    return done;
  });
  const path = (id: string, action: string) => `/admin/api/accounts/${encodeURIComponent(id)}/${action}`;

  const [settingPassword, setSettingPassword] = useState<{ id: string; email: string }>();
  const [passwordError, setPasswordError] = useState<string>();
  const passwordTask = useTask();

  function row(entry: Listed) {
    const self = entry.id === viewer?.id;
    const protectedOwner = entry.instanceRole === 'owner' && overview.role !== 'owner';
    const actions = [
      ...(!self && !protectedOwner ? [{ id: 'status', label: entry.enabled ? t('Disable account', '停用账号') : t('Enable account', '启用账号') }] : []),
      { id: 'reset', label: t('Create password reset link', '生成密码重置链接') },
      { id: 'set-password', label: t('Set password', '设置密码') },
      ...(!entry.emailVerified ? [{ id: 'verify', label: t('Mark email as verified', '标记邮箱为已验证') }] : []),
      ...(overview.role === 'owner' && !self && entry.instanceRole !== 'owner'
        ? [{ id: 'role', label: entry.instanceRole ? t('Remove administrator role', '取消管理员身份') : t('Make administrator', '设为管理员') }] : []),
      ...(!self && !entry.instanceRole ? [{ id: 'delete', label: t('Delete account', '删除账号'), danger: true }] : []),
    ];
    function choose(action: string) {
      if (action === 'delete') return setDeleting(entry.id);
      if (action === 'set-password') return setSettingPassword({ id: entry.id, email: entry.email });
      if (action === 'status') {
        return act(entry.id, async () => {
          await call(path(entry.id, 'status'), { status: entry.enabled ? 'disabled' : 'enabled' });
          return entry.enabled ? t(`${entry.email} is disabled and signed out everywhere.`, `${entry.email} 已停用，并已退出所有设备。`) : t(`${entry.email} is enabled.`, `${entry.email} 已启用。`);
        });
      }
      if (action === 'reset') {
        return act(entry.id, async () => {
          const issued = await call<{ link: string }>(path(entry.id, 'reset-link'), {});
          setLink({ email: entry.email, link: issued.link });
        });
      }
      if (action === 'verify') {
        return act(entry.id, async () => {
          await call(path(entry.id, 'verify-email'), {});
          return t(`${entry.email} is marked as verified.`, `${entry.email} 已标记为已验证。`);
        });
      }
      return act(entry.id, async () => {
        await call(path(entry.id, 'role'), { role: entry.instanceRole ? 'none' : 'admin' });
        return entry.instanceRole ? t(`${entry.email} is no longer an administrator.`, `${entry.email} 不再是管理员。`) : t(`${entry.email} is now an administrator.`, `${entry.email} 已成为管理员。`);
      });
    }
    return <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0" data-account={entry.email}>
      <div className="grid min-w-0 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium wrap-anywhere">{entry.email}</span>
          {self && <State color="accent">{t('You', '你')}</State>}
          {entry.instanceRole && <State color="accent">{entry.instanceRole === 'owner' ? t('Owner', '所有者') : t('Administrator', '管理员')}</State>}
          <State color={entry.enabled ? 'success' : 'danger'}>{entry.enabled ? t('Enabled', '已启用') : t('Disabled', '已停用')}</State>
          <State color={entry.emailVerified ? 'default' : 'warning'}>{entry.emailVerified ? t('Verified', '已验证') : t('Not verified', '未验证')}</State>
        </div>
        <p className="text-sm text-muted wrap-anywhere">{[entry.name, t(`Created ${time(entry.createdAt)}`, `创建于 ${time(entry.createdAt)}`),
          entry.deletionRequestedAt && t(`asked for deletion ${time(entry.deletionRequestedAt)}`, `${time(entry.deletionRequestedAt)} 申请删除`)].filter(Boolean).join(' · ')}</p>
      </div>
      {overview.canWrite && (deleting === entry.id ? <span className="inline-flex flex-wrap items-center gap-2">
        <Button size="sm" variant="danger" autoFocus onPress={() => {
          setDeleting(undefined);
          void task.run(entry.id, async () => {
            try { await call(path(entry.id, 'delete'), {}); }
            catch (failure) {
              if (failure instanceof RequestFailure && failure.code === 'sole_team_owner' && Array.isArray(failure.detail.teams)) {
                const teams = failure.detail.teams.map(String).join(t(', ', '、'));
                return task.setError(t(`${entry.email} is the only owner of ${teams}. Give those teams another owner first.`, `${entry.email} 是 ${teams} 的唯一所有者，请先为这些团队指定其他所有者。`));
              }
              throw failure;
            }
            await Promise.all([list.reload(), reload()]);
            return t('The account was deleted.', '账号已删除。');
          });
        }}>{t('Delete permanently', '永久删除')}</Button>
        <Button size="sm" variant="tertiary" onPress={() => setDeleting(undefined)}>{t('Cancel', '取消')}</Button>
      </span> : <Dropdown>
        <Button size="sm" variant="secondary" isPending={task.pending === entry.id} aria-label={t(`Manage ${entry.email}`, `管理 ${entry.email}`)}>{t('Manage', '管理')}</Button>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu aria-label={t(`Manage ${entry.email}`, `管理 ${entry.email}`)} onAction={key => choose(String(key))}>
            {actions.map(action => <Dropdown.Item key={action.id} id={action.id} textValue={action.label} {...('danger' in action ? { variant: 'danger' as const } : {})}>
              <Label>{action.label}</Label>
            </Dropdown.Item>)}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>)}
    </li>;
  }

  return <Panel>
    <Form className="flex max-w-md flex-wrap items-end gap-3" validationBehavior="native" role="search" onSubmit={event => setQuery(readForm(event)('q').trim())}>
      <TextField name="q" type="search" className="min-w-0 flex-1 basis-48">
        <Label>{t('Search by email or name', '按邮箱或名称搜索')}</Label><Input className="w-full min-w-0" />
      </TextField>
      <Button type="submit" variant="secondary">{t('Search', '搜索')}</Button>
    </Form>
    <TaskFeedback task={task} />
    {link && <Secret title={t(`Password reset link for ${link.email}`, `${link.email} 的密码重置链接`)}
      note={t('Send it to the account holder. It works once, for 24 hours, and is shown only now.', '请把它交给账号持有人。链接 24 小时内有效，只能使用一次，且只在此处显示一次。')}
      onDone={() => setLink(undefined)} values={[{ label: t('Reset link', '重置链接'), value: link.link, name: 'reset-link' }]} />}
    {settingPassword && <Panel title={t(`Set password for ${settingPassword.email}`, `为 ${settingPassword.email} 设置密码`)}>
      <TaskFeedback task={passwordTask} />
      <Form className="flex max-w-md flex-wrap items-end gap-3" validationBehavior="native" onSubmit={event => {
        const password = readForm(event)('password');
        setPasswordError(undefined);
        void passwordTask.run('set-pw', async () => {
          try {
            await call(`/admin/api/accounts/${encodeURIComponent(settingPassword.id)}/set-password`, { password });
            setSettingPassword(undefined);
            return t('Password has been set.', '密码已设置。');
          } catch (failure) {
            const code = codeOf(failure);
            if (code === 'invalid_password' || code === 'common_password') { setPasswordError(problem(failure, language)); return; }
            throw failure;
          }
        });
      }}>
        <TextField name="password" type="password" autoComplete="new-password" isRequired isInvalid={Boolean(passwordError)}
          onChange={() => setPasswordError(undefined)} className="min-w-0 flex-1 basis-48">
          <Label>{t('New password', '新密码')}</Label><Input className="w-full min-w-0" />
        </TextField>
        {passwordError && <p role="alert" className="text-sm text-danger">{passwordError}</p>}
        <div className="flex gap-2">
          <Button type="submit" isPending={passwordTask.pending === 'set-pw'}>{t('Set password', '设置密码')}</Button>
          <Button variant="tertiary" onPress={() => setSettingPassword(undefined)}>{t('Cancel', '取消')}</Button>
        </div>
      </Form>
    </Panel>}
    <Loaded source={list}>{({ accounts }) => {
      const requested = accounts.filter(entry => entry.deletionRequestedAt);
      const others = accounts.filter(entry => !entry.deletionRequestedAt);
      if (!accounts.length) return <Empty>{t('No accounts match.', '没有匹配的账号。')}</Empty>;
      return <>
        {requested.length > 0 && <section className="grid gap-2">
          <h3 className="text-sm font-medium">{t('Asked to be deleted', '申请删除的账号')}</h3>
          <ul className="grid divide-y divide-separator">{requested.map(row)}</ul>
        </section>}
        {others.length > 0 && <section className="grid gap-2">
          {requested.length > 0 && <h3 className="text-sm font-medium">{t('All other accounts', '其他账号')}</h3>}
          <ul className="grid divide-y divide-separator">{others.map(row)}</ul>
        </section>}
      </>;
    }}</Loaded>
  </Panel>;
}

function AllTeams() {
  const { t } = useApp();
  const time = useTime();
  const list = useLoad(() => call<{ teams: Array<{ id: string; name: string; createdAt: string; members: number; owners: string }> }>('/admin/api/teams'), 'admin-teams');
  return <Panel description={t('Each team is managed by its own owners.', '团队由各自的所有者管理。')}>
    <Loaded source={list}>{({ teams }) => teams.length ? <Table>
      <Table.ScrollContainer>
        <Table.Content aria-label={t('Teams', '团队')} className="min-w-[36rem]">
          <Table.Header>
            <Table.Column isRowHeader>{t('Team', '团队')}</Table.Column>
            <Table.Column>{t('Owners', '所有者')}</Table.Column>
            <Table.Column>{t('Members', '成员数')}</Table.Column>
            <Table.Column>{t('Created', '创建时间')}</Table.Column>
          </Table.Header>
          <Table.Body>
            {teams.map(team => <Table.Row key={team.id} id={team.id}>
              <Table.Cell className="font-medium">{team.name}</Table.Cell>
              <Table.Cell>{team.owners}</Table.Cell>
              <Table.Cell className="tabular-nums">{team.members}</Table.Cell>
              <Table.Cell className="whitespace-nowrap">{time(team.createdAt)}</Table.Cell>
            </Table.Row>)}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table> : <Empty>{t('No teams yet.', '还没有团队。')}</Empty>}</Loaded>
  </Panel>;
}

function Applications({ console: { overview, reload } }: { console: Console }) {
  const { t } = useApp();
  const task = useTask();
  const policy = overview.teamApplications;
  const [enabled, setEnabled] = useState(String(policy.enabled));
  const [network, setNetwork] = useState(String(policy.privateNetwork));
  return <ApplicationManager base="/admin/api/applications" canWrite={overview.canWrite} showOwner onChanged={reload}>
    <Panel title={t('Applications added by teams', '团队自行添加的应用')}
      description={t('A team’s own application is open to that team’s members only.', '团队自己添加的应用只对该团队成员开放。')}>
      <TaskFeedback task={task} />
      <Form className="grid gap-4" validationBehavior="native" onSubmit={event => {
        const limit = readForm(event)('limit').trim();
        void task.run('save', async () => {
          await call('/admin/api/team-applications', { enabled, limit, privateNetwork: network });
          await reload();
          return t('Setting saved.', '设置已保存。');
        });
      }}>
        <div className="grid gap-4 sm:grid-cols-3">
          <Choice label={t('Teams may add applications', '允许团队添加应用')} value={enabled} onChange={setEnabled} isDisabled={!overview.canWrite}
            options={[{ id: 'true', label: t('Allowed', '允许') }, { id: 'false', label: t('Not allowed', '不允许') }]} />
          <TextField name="limit" type="number" isRequired defaultValue={String(policy.limit)} isDisabled={!overview.canWrite}>
            <Label>{t('Applications per team', '每个团队的应用上限')}</Label><Input className="w-full min-w-0" min={1} max={1000} inputMode="numeric" />
          </TextField>
          <Choice label={t('Application addresses', '应用地址')} value={network} onChange={setNetwork} isDisabled={!overview.canWrite}
            options={[{ id: 'false', label: t('Public internet only', '仅限公网地址') }, { id: 'true', label: t('Private network allowed', '允许内网地址') }]} />
        </div>
        {overview.canWrite && <div><Button type="submit" variant="secondary" isPending={task.pending === 'save'}>{t('Save', '保存')}</Button></div>}
      </Form>
    </Panel>
  </ApplicationManager>;
}

function Mail({ console: { overview, reload } }: { console: Console }) {
  const { t } = useApp();
  const task = useTask();
  const { mail } = overview;
  const [editing, setEditing] = useState(false);
  const managed = mail.source === 'environment' || mail.source === 'tencent-ses';
  return <>
    <Panel title={t('Mail server', '发信服务器')} aside={<State color={mail.source === 'none' ? 'warning' : 'success'}>{mail.source === 'none' ? t('Not configured', '未配置') : t('Working', '已配置')}</State>}>
      <TaskFeedback task={task} />
      {mail.source === 'none' && <Empty>{t('Identity cannot send mail yet. Add a mail server below.', 'Identity 目前无法发信。请在下方添加发信服务器。')}</Empty>}
      {managed && <Empty>{t('Mail is set in this deployment’s configuration and cannot be changed here.', '发信由部署配置指定，无法在此修改。')}</Empty>}
      {mail.host && <dl className="grid gap-3 sm:grid-cols-2">
        <div><dt className="text-sm text-muted">{t('SMTP server', 'SMTP 服务器')}</dt><dd className="wrap-anywhere">{mail.host}:{mail.port}</dd></div>
        <div><dt className="text-sm text-muted">{t('Encryption', '加密方式')}</dt><dd>{mail.security === 'none' ? t('None', '无') : mail.security?.toUpperCase()}</dd></div>
        <div><dt className="text-sm text-muted">{t('Sender address', '发件人地址')}</dt><dd className="wrap-anywhere">{mail.from}</dd></div>
        {mail.username && <div><dt className="text-sm text-muted">{t('Username', '用户名')}</dt><dd className="wrap-anywhere">{mail.username}</dd></div>}
      </dl>}
      {mail.source === 'instance' && overview.canWrite && <div className="flex flex-wrap gap-2">
        {!editing && <Button variant="secondary" size="sm" onPress={() => setEditing(true)}>{t('Change settings', '修改设置')}</Button>}
        <ConfirmButton label={t('Remove mail settings', '移除发信配置')} confirm={t('Confirm removal', '确认移除')} pending={task.pending === 'remove'}
          onConfirm={() => void task.run('remove', async () => {
            await call('/admin/api/mail/remove', {});
            setEditing(false);
            await reload();
            return t('Mail settings removed.', '发信配置已移除。');
          })} />
      </div>}
    </Panel>
    {!managed && overview.canWrite && (mail.source === 'none' || editing) && <Panel title={mail.source === 'none' ? t('Add a mail server', '添加发信服务器') : t('Change mail server', '修改发信服务器')}
      description={t('We send a test message to your own address before saving.', '保存前会向你的邮箱发送一封测试邮件。')}>
      <MailSetup defaults={mail} begin={values => call<{ sentTo: string }>('/admin/api/mail', values)} confirm={code => call('/admin/api/mail/confirm', { code })}
        onConfirmed={async () => { setEditing(false); await reload(); }} />
    </Panel>}
  </>;
}
