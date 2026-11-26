import { Button, Card, FieldError, Form, Input, Label, Link, Modal, TextField } from '@heroui/react';
import ChevronRight from '@gravity-ui/icons/ChevronRight';
import Clock from '@gravity-ui/icons/Clock';
import Gear from '@gravity-ui/icons/Gear';
import House from '@gravity-ui/icons/House';
import Key from '@gravity-ui/icons/Key';
import LayoutCellsLarge from '@gravity-ui/icons/LayoutCellsLarge';
import Person from '@gravity-ui/icons/Person';
import Persons from '@gravity-ui/icons/Persons';
import ShieldCheck from '@gravity-ui/icons/ShieldCheck';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { call, codeOf, problem } from './api';
import type { Account, AgentToken, Team, TeamRole } from './api';
import { SidebarLayout } from './sidebar-layout';
import { followRoute, pathFor } from './site';
import type { Route } from './site';
import {
  Choice, CodeField, ConfirmButton, CopyButton, Empty, Loaded, Notice, PageLink, Panel, ResendCodeButton, Secret, State, TaskFeedback, readForm, useApp, useLoad, useTask, useTime,
} from './ui';

export function Workspace({ route }: { route: Route }) {
  const { t, account } = useApp();
  if (!account) return null;
  const pages = [
    { id: undefined, label: t('Overview', '概览'), icon: House, content: <Overview /> },
    { id: 'applications', label: t('Applications', '应用'), icon: LayoutCellsLarge, content: <Applications /> },
    { id: 'sessions', label: t('Sessions', '登录状态'), icon: Clock, content: <Sessions /> },
    { id: 'teams', label: t('Teams', '团队'), icon: Persons, content: <Teams team={route.team} /> },
    { id: 'tokens', label: t('Agent tokens', 'Agent 令牌'), icon: Key, content: <Tokens /> },
    { id: 'security', label: t('Security', '安全'), icon: ShieldCheck, content: <Security /> },
    { id: 'settings', label: t('Settings', '设置'), icon: Gear, content: route.accountManagement ? <AccountManagement /> : <Preferences /> },
  ];
  const active = pages.find(({ id }) => id === route.tab) ?? pages[0]!;
  const title = t('Account center', '账号中心');
  return <SidebarLayout title={title} navigation={t('Account navigation', '账号中心导航')}
    openNavigation={t('Open account navigation', '打开账号中心导航')} route={route} pages={pages} activeTab={active.id} account={account}>
    {route.accountManagement && <PageLink to={{ section: 'workspace', tab: 'settings' }} className="justify-self-start">
      {t('Back to settings', '返回设置')}
    </PageLink>}
    <h1 className="text-balance text-3xl font-semibold tracking-tight">
      {route.accountManagement ? t('Account management', '账号管理') : active.id ? active.label : title}
    </h1>
    {active.content}
  </SidebarLayout>;
}

function Overview() {
  const { t, account, settings, refresh } = useApp();
  const profile = useTask();
  const email = useTask();
  if (!account) return null;
  return <>
    <Panel title={t('Profile', '个人资料')}>
      <TaskFeedback task={profile} />
      <Form className="grid max-w-md gap-4" validationBehavior="native" onSubmit={event => {
        const name = readForm(event)('name');
        void profile.run('save', async () => {
          await call('/account/profile', { name });
          await refresh();
          return t('Profile saved.', '个人资料已保存。');
        });
      }}>
        <TextField name="name" defaultValue={account.name ?? ''} autoComplete="name">
          <Label>{t('Display name', '显示名称')}</Label><Input className="w-full min-w-0" maxLength={80} />
        </TextField>
        <div><Button type="submit" isPending={profile.pending === 'save'}>{t('Save', '保存')}</Button></div>
      </Form>
    </Panel>
    <Panel title={t('Email', '邮箱')}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="wrap-anywhere">{account.email}</span>
        <State color={account.emailVerified ? 'success' : 'warning'}>{account.emailVerified ? t('Verified', '已验证') : t('Not verified', '未验证')}</State>
      </div>
      <TaskFeedback task={email} />
      {!account.emailVerified && (settings?.recoveryAvailable
        ? <div><Button variant="secondary" isPending={email.pending === 'send'} onPress={() => void email.run('send', async () => {
          await call('/account/email/verification', {});
          return t(`We sent a verification link to ${account.email}.`, `验证链接已发送到 ${account.email}。`);
        })}>{t('Send verification email', '发送验证邮件')}</Button></div>
        : <Empty>{t('This instance cannot send mail. Ask an administrator to verify your address.', '此实例无法发信，请联系管理员为你验证邮箱。')}</Empty>)}
    </Panel>
  </>;
}

function Preferences() {
  const { account, language, navigate, refresh, t } = useApp();
  const task = useTask();
  const [locale, setLocale] = useState<string>(account?.locale ?? 'browser');
  const management: Route = { language, section: 'workspace', tab: 'settings', accountManagement: true };
  return <>
    <Panel title={t('Preferences', '偏好设置')}
      description={t('Choose the language for verification and password reset pages opened from an email.', '选择从邮件打开的验证和密码重置页面的语言。')}>
      <TaskFeedback task={task} />
      <Form className="grid max-w-md gap-4" onSubmit={event => {
        event.preventDefault();
        void task.run('save', async () => {
          await call('/account/preferences', { locale: locale === 'browser' ? '' : locale });
          await refresh();
          return t('Link language saved.', '邮件链接语言已保存。');
        });
      }}>
        <Choice label={t('Email link language', '邮件链接语言')} value={locale} onChange={setLocale} options={[
          { id: 'browser', label: t('Same as this browser', '跟随浏览器') }, { id: 'en', label: 'English' }, { id: 'zh-CN', label: '简体中文' }]} />
        <div><Button type="submit" isPending={task.pending === 'save'}>{t('Save', '保存')}</Button></div>
      </Form>
    </Panel>
    <Card<'a'> className="min-h-14 flex-row items-center font-medium hover:bg-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      render={props => <a {...props} />} href={pathFor(management)} onClick={event => followRoute(event, management, navigate)}>
      <Person width={18} height={18} className="shrink-0 text-muted" aria-hidden="true" />
      <span className="flex-1">{t('Account management', '账号管理')}</span>
      <ChevronRight width={16} height={16} className="shrink-0 text-muted" aria-hidden="true" />
    </Card>
  </>;
}

function AccountManagement() {
  const { t, account, refresh } = useApp();
  const deletion = useTask();
  if (!account) return null;
  return <Panel title={t('Delete account', '删除账号')}>
      <TaskFeedback task={deletion} />
      {account.deletionRequested ? <>
        <Notice status="warning">{t('You asked to delete this account. An administrator will handle the request. Your account works until then.',
          '你已申请删除此账号，管理员会处理该申请。在此之前账号仍可正常使用。')}</Notice>
        <div><Button variant="secondary" isPending={deletion.pending === 'change'} onPress={() => void deletion.run('change', async () => {
          await call('/account/deletion-request', { state: 'withdrawn' });
          await refresh();
        })}>{t('Withdraw request', '撤回申请')}</Button></div>
      </> : <>
        <Empty>{t('An administrator deletes accounts. After deletion you can no longer sign in, and each application decides what happens to your data there.',
          '账号由管理员删除。删除后无法再登录，各应用中的数据由应用自行处理。')}</Empty>
        <div><ConfirmButton label={t('Request account deletion', '申请删除账号')} confirm={t('Confirm request', '确认申请')} pending={deletion.pending === 'change'}
          onConfirm={() => void deletion.run('change', async () => {
            await call('/account/deletion-request', { state: 'requested' });
            await refresh();
          })} /></div>
      </>}
  </Panel>;
}

type AuthorizedApplication = { id: string; name: string; url: string };

function Applications() {
  const { settings, t } = useApp();
  const list = useLoad(() => call<{ applications: AuthorizedApplication[] }>('/account/applications'), 'applications');
  const [notice, setNotice] = useState<string>();
  return <>
    {notice && <Notice status="success">{notice}</Notice>}
    <Loaded source={list}>{({ applications }) => {
      const available = settings?.applications.filter(app => !applications.some(authorized => authorized.id === app.id)) ?? [];
      return <>
        <Panel title={t('Authorized applications', '已授权应用')}>
          {applications.length ? <ul className="grid divide-y divide-separator">
            {applications.map(app => <li key={app.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <Link href={app.url} target="_blank" rel="noreferrer" className="wrap-anywhere">{app.name}<Link.Icon /></Link>
              <RevokeApplication app={app} onRevoked={() => {
                setNotice(t(`Access revoked for ${app.name}.`, `已撤销 ${app.name} 的授权。`));
                void list.reload();
              }} />
            </li>)}
          </ul> : <Empty>{t('You have no authorized applications.', '你还没有已授权的应用。')}</Empty>}
        </Panel>
        {available.length > 0 && <Panel title={t('Available applications', '可用应用')}>
          <ul className="grid gap-2">
            {available.map(app => <li key={app.id}><Link href={app.url} target="_blank" rel="noreferrer">{app.name}<Link.Icon /></Link></li>)}
          </ul>
        </Panel>}
      </>;
    }}</Loaded>
  </>;
}

function RevokeApplication({ app, onRevoked }: { app: AuthorizedApplication; onRevoked: () => void }) {
  const { t, language } = useApp();
  const task = useTask();
  const [open, setOpen] = useState(false);
  const [passwordError, setPasswordError] = useState<string>();
  const pending = Boolean(task.pending);
  const revoke = t('Revoke access', '撤销授权');
  return <Modal isOpen={open} onOpenChange={next => {
    if (pending) return;
    task.setError(undefined);
    setPasswordError(undefined);
    setOpen(next);
  }}>
    <Button size="sm" variant="secondary" aria-label={t(`Revoke access for ${app.name}`, `撤销 ${app.name} 的授权`)}>{revoke}</Button>
    <Modal.Backdrop isDismissable={!pending} isKeyboardDismissDisabled={pending}>
      <Modal.Container>
        <Modal.Dialog>
          <Modal.Header><Modal.Heading className="wrap-anywhere">
            {t(`Revoke access for ${app.name}?`, `撤销 ${app.name} 的授权？`)}
          </Modal.Heading></Modal.Header>
          <Form className="contents" onSubmit={event => {
            const password = readForm(event)('password');
            void task.run('revoke', async () => {
              try {
                await call(`/account/applications/${encodeURIComponent(app.id)}/revoke`, { password });
              } catch (failure) {
                if (codeOf(failure) !== 'incorrect_password') throw failure;
                setPasswordError(problem(failure, language));
                return;
              }
              setOpen(false);
              onRevoked();
            });
          }}>
            <Modal.Body className="grid gap-4">
              <p className="text-muted">
                {t('This ends your sign-in sessions for this application on all devices. Sign in to the application again to restore access.',
                  '此应用会在所有设备上退出登录。再次登录此应用即可重新授权。')}
              </p>
              <TaskFeedback task={task} />
              <TextField name="password" type="password" autoComplete="current-password" autoFocus isRequired
                isInvalid={Boolean(passwordError)} isReadOnly={pending} onChange={() => setPasswordError(undefined)}>
                <Label>{t('Current password', '当前密码')}</Label>
                <Input className="w-full min-w-0" />
                <FieldError>{passwordError}</FieldError>
              </TextField>
            </Modal.Body>
            <Modal.Footer>
              <Button type="button" slot="close" variant="tertiary" isDisabled={pending}>{t('Cancel', '取消')}</Button>
              <Button type="submit" variant="danger" isPending={pending}>{revoke}</Button>
            </Modal.Footer>
          </Form>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  </Modal>;
}

function browserName(agent: string | null, unknown: string) {
  if (!agent) return unknown;
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : undefined;
  const system = /Windows/.test(agent) ? 'Windows' : /Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iOS' : /Mac OS X/.test(agent) ? 'macOS' : /Linux/.test(agent) ? 'Linux' : undefined;
  return [browser, system].filter(Boolean).join(' · ') || unknown;
}

type Session = { kind: 'account' | 'applications'; id: string; createdAt: string; expiresAt: string; userAgent: string | null; current: boolean; applications: string[] };

function Sessions() {
  const { t, refresh } = useApp();
  const time = useTime();
  const task = useTask();
  const list = useLoad(() => call<{ sessions: Session[] }>('/account/sessions'), 'sessions');
  return <>
    <Panel title={t('Where you are signed in', '已登录的位置')}>
      <TaskFeedback task={task} />
      <Loaded source={list}>{({ sessions }) => <ul className="grid divide-y divide-separator">
        {sessions.map(session => <li key={session.kind + session.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
          <div className="grid min-w-0 gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium wrap-anywhere">{session.kind === 'account'
                ? `${t('Account center', '账号中心')} · ${browserName(session.userAgent, t('Unknown browser', '未知浏览器'))}`
                : `${t('Single sign-on', '单点登录')} · ${session.applications.join(', ') || t('No application opened yet', '尚未打开应用')}`}</span>
              {session.current && <State color="accent">{t('This browser', '当前浏览器')}</State>}
            </div>
            <p className="text-sm text-muted">{t(`Signed in ${time(session.createdAt)} · ends ${time(session.expiresAt)}`, `登录于 ${time(session.createdAt)} · ${time(session.expiresAt)} 到期`)}</p>
          </div>
          <Button size="sm" variant="secondary" isPending={task.pending === session.id} onPress={() => void task.run(session.id, async () => {
            await call('/account/sessions/revoke', { kind: session.kind, id: session.id });
            if (session.current) await refresh();
            else await list.reload();
          })}>{t('Sign out', '退出')}</Button>
        </li>)}
      </ul>}</Loaded>
    </Panel>
    <Panel title={t('Sign out', '退出登录')} description={t('To sign out of one application only, use "Sign out of this app" inside that application.', '只想退出某个应用时，请在该应用内使用「退出当前应用」。')}>
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 text-sm text-muted">{t('Ends every session on every device, including all applications.', '结束所有设备上的全部会话，包括所有应用。')}</p>
          <ConfirmButton size="md" label={t('Sign out of all devices', '退出所有设备')} confirm={t('Confirm: sign out everywhere', '确认退出所有设备')} pending={task.pending === 'all'}
            onConfirm={() => void task.run('all', async () => {
              await call('/account/end-sessions', {});
              await refresh();
            })} />
        </div>
      </div>
    </Panel>
  </>;
}

const teamLabel = (team: { name: string; personal: boolean }, t: (en: string, zh: string) => string) => team.personal ? t('Personal space', '个人空间') : team.name;
function useRoles() {
  const { t } = useApp();
  return { owner: t('Owner', '所有者'), admin: t('Admin', '管理员'), member: t('Member', '成员') } satisfies Record<TeamRole, string>;
}

function Teams({ team }: { team: string | undefined }) {
  const { t, language, navigate } = useApp();
  const roles = useRoles();
  const task = useTask();
  const list = useLoad(() => call<{ orgs: Team[] }>('/account/orgs'), 'orgs');
  if (team) return <TeamDetail key={team} id={team} />;
  return <>
    <Panel title={t('Your teams', '我的团队')}>
      <Loaded source={list}>{({ orgs }) => <ul className="grid divide-y divide-separator">
        {orgs.map(org => <li key={org.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {org.personal ? <span className="font-medium">{teamLabel(org, t)}</span>
              : <PageLink className="font-medium wrap-anywhere" to={{ section: 'workspace', tab: 'teams', team: org.id }}>{org.name}</PageLink>}
            <State>{roles[org.role]}</State>
          </div>
          <span className="text-sm text-muted">{org.personal ? t('Only you', '仅你自己') : t(org.members === 1 ? '1 member' : `${org.members} members`, `${org.members} 位成员`)}</span>
        </li>)}
      </ul>}</Loaded>
    </Panel>
    <Panel title={t('Create a team', '创建团队')}>
      <TaskFeedback task={task} />
      <Form className="flex max-w-md flex-wrap items-end gap-3" validationBehavior="native" onSubmit={event => {
        const name = readForm(event)('name');
        void task.run('create', async () => {
          const created = await call<Team>('/account/orgs', { name });
          navigate({ language, section: 'workspace', tab: 'teams', team: created.id });
        });
      }}>
        <TextField name="name" isRequired className="min-w-0 flex-1 basis-48">
          <Label>{t('Team name', '团队名称')}</Label><Input className="w-full min-w-0" maxLength={80} />
        </TextField>
        <Button type="submit" isPending={task.pending === 'create'}>{t('Create team', '创建团队')}</Button>
      </Form>
    </Panel>
  </>;
}

type Member = { id: string; email: string; name: string | null; role: TeamRole; enabled: boolean; joinedAt: string };
type Pending = { id: string; email: string; role: TeamRole; createdAt: string; expiresAt: string };
type Detail = { org: Omit<Team, 'members'>; members: Member[]; invitations: Pending[] };

function TeamDetail({ id }: { id: string }) {
  const { t, language, navigate, account } = useApp();
  const roles = useRoles();
  const time = useTime();
  const members = useTask();
  const naming = useTask();
  const inviting = useTask();
  const [inviteRole, setInviteRole] = useState('member');
  const [issued, setIssued] = useState<{ email: string; link: string; delivered: boolean }>();
  const base = `/account/orgs/${encodeURIComponent(id)}`;
  const detail = useLoad(() => call<Detail>(base), 'team:' + id);
  const back = <PageLink to={{ section: 'workspace', tab: 'teams' }}>{t('All teams', '全部团队')}</PageLink>;
  if (detail.error && codeOf(detail.error) === 'team_not_found') {
    return <><Notice status="danger">{problem(detail.error, language)}</Notice>{back}</>;
  }
  return <>
    <div>{back}</div>
    <Loaded source={detail}>{({ org, members: people, invitations }) => {
      const manages = !org.personal && (org.role === 'owner' || org.role === 'admin');
      const owners = people.filter(person => person.role === 'owner').length;
      const soleOwner = org.role === 'owner' && owners === 1;
      return <>
        <Panel title={teamLabel(org, t)} aside={<State>{roles[org.role]}</State>}>
          {manages && <>
            <TaskFeedback task={naming} />
            <Form className="flex max-w-md flex-wrap items-end gap-3" validationBehavior="native" onSubmit={event => {
              const name = readForm(event)('name');
              void naming.run('rename', async () => {
                await call(base + '/rename', { name });
                await detail.reload();
                return t('Team renamed.', '团队已重命名。');
              });
            }}>
              <TextField name="name" isRequired defaultValue={org.name} className="min-w-0 flex-1 basis-48">
                <Label>{t('Team name', '团队名称')}</Label><Input className="w-full min-w-0" maxLength={80} />
              </TextField>
              <Button type="submit" variant="secondary" isPending={naming.pending === 'rename'}>{t('Rename', '重命名')}</Button>
            </Form>
          </>}
        </Panel>
        <Panel title={t('Members', '成员')}>
          <TaskFeedback task={members} />
          {soleOwner && people.length > 1 && <Empty>{t('You are the only owner. Make someone else an owner before you leave or change your role.',
            '你是唯一的所有者。离开团队或更改自己的角色前，请先将其他成员设为所有者。')}</Empty>}
          <ul className="grid divide-y divide-separator">
            {people.map(person => {
              const self = person.id === account?.id;
              const lastOwner = person.role === 'owner' && owners === 1;
              const removable = !org.personal && !self && manages && (person.role !== 'owner' || org.role === 'owner');
              return <li key={person.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0" data-member={person.email}>
                <div className="grid min-w-0 gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium wrap-anywhere">{person.name ?? person.email}</span>
                    {self && <State color="accent">{t('You', '你')}</State>}
                    {!person.enabled && <State color="danger">{t('Disabled', '已停用')}</State>}
                    {(org.role !== 'owner' || org.personal) && <State>{roles[person.role]}</State>}
                  </div>
                  {person.name && <p className="text-sm text-muted wrap-anywhere">{person.email}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {org.role === 'owner' && !org.personal && <Choice hideLabel className="w-36" label={t(`Role of ${person.email}`, `${person.email} 的角色`)} value={person.role} onChange={role => void members.run('role', async () => {
                      await call(`${base}/members/${encodeURIComponent(person.id)}/role`, { role });
                      await detail.reload();
                    })} options={(['owner', 'admin', 'member'] as const).map(role => ({ id: role, label: roles[role] }))} />}
                  {removable && <ConfirmButton label={t('Remove', '移除')} confirm={t('Confirm removal', '确认移除')} pending={members.pending === person.id}
                    onConfirm={() => void members.run(person.id, async () => {
                      await call(`${base}/members/${encodeURIComponent(person.id)}/remove`, {});
                      await detail.reload();
                    })} />}
                  {self && !org.personal && <ConfirmButton label={t('Leave team', '离开团队')} confirm={t('Confirm leaving', '确认离开')} isDisabled={lastOwner && people.length > 1}
                    pending={members.pending === person.id} onConfirm={() => void members.run(person.id, async () => {
                      await call(`${base}/members/${encodeURIComponent(person.id)}/remove`, {});
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
              await detail.reload();
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
                  await detail.reload();
                })}>{t('Withdraw', '撤回')}</Button>
              </li>)}
            </ul>
          </div>}
        </Panel>}
      </>;
    }}</Loaded>
  </>;
}

function Tokens() {
  const { t, settings } = useApp();
  const time = useTime();
  const task = useTask();
  const creating = useTask();
  const list = useLoad(() => call<{ tokens: AgentToken[] }>('/account/tokens'), 'tokens');
  const orgs = useLoad(() => call<{ orgs: Team[] }>('/account/orgs'), 'orgs');
  const [app, setApp] = useState('');
  const [org, setOrg] = useState('');
  const [days, setDays] = useState('90');
  const [issued, setIssued] = useState<string>();
  const applications = settings?.applications ?? [];
  const chosenApp = app || applications[0]?.id || '';
  const chosenOrg = org || orgs.data?.orgs[0]?.id || '';
  return <>
    <Panel title={t('Agent tokens', 'Agent 令牌')} description={t('A token lets an agent or script act as you in one application and one team.', '令牌让 Agent 或脚本以你的身份访问一个应用中的一个团队。')}>
      <TaskFeedback task={task} />
      <Loaded source={list}>{({ tokens }) => tokens.length ? <ul className="grid divide-y divide-separator">
        {tokens.map(token => <li key={token.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0" data-token={token.name}>
          <div className="grid min-w-0 gap-1">
            <span className="font-medium wrap-anywhere">{token.name} <span className="font-normal text-muted">…{token.hint}</span></span>
            <p className="text-sm text-muted wrap-anywhere">{token.appName} · {teamLabel({ name: token.orgName, personal: token.personal }, t)}</p>
            <p className="text-sm text-muted">{[t(`Created ${time(token.createdAt)}`, `创建于 ${time(token.createdAt)}`),
              token.expiresAt ? t(`expires ${time(token.expiresAt)}`, `${time(token.expiresAt)} 过期`) : t('no expiry', '不过期'),
              token.lastUsedAt ? t(`last used ${time(token.lastUsedAt)}`, `最近使用于 ${time(token.lastUsedAt)}`) : t('never used', '尚未使用')].join(' · ')}</p>
          </div>
          <ConfirmButton label={t('Revoke', '撤销')} confirm={t('Confirm revoke', '确认撤销')} pending={task.pending === token.id}
            onConfirm={() => void task.run(token.id, async () => {
              await call(`/account/tokens/${encodeURIComponent(token.id)}/revoke`, {});
              await list.reload();
            })} />
        </li>)}
      </ul> : <Empty>{t('No tokens yet.', '还没有令牌。')}</Empty>}</Loaded>
    </Panel>
    <Panel title={t('Create a token', '创建令牌')}>
      <TaskFeedback task={creating} />
      {applications.length === 0 ? <Empty>{t('Tokens need a connected application. None is connected yet.', '令牌需要对应一个已接入的应用，目前还没有应用。')}</Empty>
        : <Form className="grid gap-4" validationBehavior="native" onSubmit={event => {
          const name = readForm(event)('name');
          const form = event.currentTarget;
          void creating.run('create', async () => {
            const created = await call<{ token: string }>('/account/tokens', { name, app: chosenApp, org: chosenOrg, days: days === 'never' ? '' : days });
            setIssued(created.token);
            form.reset();
            await list.reload();
          });
        }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField name="name" isRequired><Label>{t('Name', '名称')}</Label><Input className="w-full min-w-0" maxLength={80} autoComplete="off" /></TextField>
            <Choice label={t('Application', '应用')} value={chosenApp} onChange={setApp} options={applications.map(({ id, name }) => ({ id, label: name }))} />
            <Choice label={t('Team', '团队')} value={chosenOrg} onChange={setOrg} options={(orgs.data?.orgs ?? []).map(entry => ({ id: entry.id, label: teamLabel(entry, t) }))} />
            <Choice label={t('Valid for', '有效期')} value={days} onChange={setDays} options={[
              ...[7, 30, 90, 365].map(count => ({ id: String(count), label: t(`${count} days`, `${count} 天`) })), { id: 'never', label: t('No expiry', '不过期') }]} />
          </div>
          <div><Button type="submit" isDisabled={!chosenOrg} isPending={creating.pending === 'create'}>{t('Create token', '创建令牌')}</Button></div>
        </Form>}
      {issued && <Secret title={t('Copy your new token now', '请立即复制新令牌')} note={t('It is shown only this once.', '令牌只在此处显示一次。')}
        onDone={() => setIssued(undefined)} values={[{ label: t('Token', '令牌'), value: issued, name: 'agent-token' }]} />}
    </Panel>
  </>;
}

function QrCode({ uri, label }: { uri: string; label: string }) {
  const [image, setImage] = useState<string>();
  useEffect(() => {
    let current = true;
    void QRCode.toDataURL(uri, { margin: 2, width: 220 }).then(data => { if (current) setImage(data); }, () => undefined);
    return () => { current = false; };
  }, [uri]);
  return image ? <img src={image} alt={label} width={220} height={220} className="rounded-lg" /> : <div className="size-[220px]" aria-hidden="true" />;
}

function Security() {
  const { t, language, account, refresh } = useApp();
  const task = useTask();
  const passwordTask = useTask();
  const [setup, setSetup] = useState<{ secret: string; uri: string }>();
  const [codeError, setCodeError] = useState<string>();
  const [disableOpen, setDisableOpen] = useState(false);
  const [disableStep, setDisableStep] = useState<{ email?: string }>();
  if (!account) return null;
  const submitCode = (path: string, done: string, after?: () => void) => (event: Parameters<typeof readForm>[0]) => {
    const code = readForm(event)('code').trim();
    setCodeError(undefined);
    void task.run('code', async () => {
      try { await call(path, { code }); }
      catch (failure) {
        if (codeOf(failure) !== 'invalid_code') throw failure;
        return setCodeError(problem(failure, language));
      }
      after?.();
      await refresh();
      return done;
    });
  };
  let body: ReactNode;
  if (account.secondFactorEnabled) {
    const pending = task.pending === 'code';
    body = <>
      <div className="flex flex-wrap items-center gap-3">
        <State color="success">{t('On', '已开启')}</State>
        <Modal isOpen={disableOpen} onOpenChange={open => {
          if (pending) return;
          task.setError(undefined);
          setCodeError(undefined);
          setDisableStep(undefined);
          setDisableOpen(open);
        }}>
          <Button size="sm" variant="secondary">{t('Manage two-step verification', '管理两步验证')}</Button>
          <Modal.Backdrop isDismissable={!pending} isKeyboardDismissDisabled={pending}>
            <Modal.Container placement="auto">
              <Modal.Dialog className="sm:max-w-md">
                <Modal.Header>
                  <Modal.Heading>{t('Turn off two-step verification?', '关闭两步验证？')}</Modal.Heading>
                </Modal.Header>
                {!disableStep ? <div className="contents">
                  <Modal.Body className="grid gap-4">
                    <p className="text-muted">{t('A verification code will be sent to your email address to confirm this change.',
                      '将向你的邮箱发送验证码以确认此操作。')}</p>
                    {task.error && <TaskFeedback task={task} />}
                  </Modal.Body>
                  <Modal.Footer className="flex-wrap">
                    <Button type="button" slot="close" variant="tertiary">{t('Cancel', '取消')}</Button>
                    <Button variant="danger" isPending={task.pending === 'request'} onPress={() => void task.run('request', async () => {
                      const result = await call<{ accepted: boolean; email: string }>('/account/second-factor/disable-request', {});
                      setDisableStep({ email: result.email });
                    })}>{t('Send verification code', '发送验证码')}</Button>
                  </Modal.Footer>
                </div> : <Form className="contents" validationBehavior="native" onSubmit={submitCode('/account/second-factor/disable',
                  t('Two-step verification is off.', '两步验证已关闭。'), () => setDisableOpen(false))}>
                  <Modal.Body className="grid gap-4">
                    <p className="text-muted">{t('Enter the code sent to ', '请输入发送至 ')}<strong>{disableStep.email}</strong>{t(' to turn off two-step verification.', ' 的验证码以关闭两步验证。')}</p>
                    {task.error && <TaskFeedback task={task} />}
                    <CodeField label={t('Verification code', '验证码')} error={codeError}
                      onInput={() => setCodeError(undefined)} />
                    <ResendCodeButton onResend={() => void task.run('resend', async () => {
                      await call('/account/second-factor/disable-resend', {});
                    })} isPending={task.pending === 'resend'} />
                  </Modal.Body>
                  <Modal.Footer className="flex-wrap">
                    <Button type="button" variant="tertiary" isDisabled={pending} onPress={() => { setDisableStep(undefined); setCodeError(undefined); }}>{t('Back', '返回')}</Button>
                    <Button type="submit" variant="danger" isPending={pending}>{t('Turn off two-step verification', '关闭两步验证')}</Button>
                  </Modal.Footer>
                </Form>}
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      </div>
    </>;
  } else if (setup) {
    body = <>
      <p className="text-sm text-muted">{t('Scan this code with an authenticator app, or type the key in by hand.', '用验证器应用扫描二维码，或手动输入密钥。')}</p>
      <QrCode uri={setup.uri} label={t('QR code for your authenticator app', '用于验证器应用的二维码')} />
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code className="min-w-0 text-sm wrap-anywhere" data-secret="totp-secret">{setup.secret}</code>
        <CopyButton value={setup.secret} label={t('Copy key', '复制密钥')} />
      </div>
      <Form className="grid max-w-sm gap-3" validationBehavior="native"
        onSubmit={submitCode('/account/second-factor/enable', t('Two-step verification is on.', '两步验证已开启。'), () => setSetup(undefined))}>
        <CodeField label={t('6-digit code from the app', '应用中显示的 6 位验证码')} error={codeError} onInput={() => setCodeError(undefined)} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" isPending={task.pending === 'code'}>{t('Turn on', '开启两步验证')}</Button>
          <Button variant="tertiary" onPress={() => { setSetup(undefined); setCodeError(undefined); }}>{t('Cancel', '取消')}</Button>
        </div>
      </Form>
    </>;
  } else {
    body = <>
      <div><State>{t('Off', '未开启')}</State></div>
      <div><Button isPending={task.pending === 'setup'} onPress={() => void task.run('setup', async () => {
        setSetup(await call<{ secret: string; uri: string }>('/account/second-factor/setup', {}));
      })}>{t('Set up two-step verification', '设置两步验证')}</Button></div>
    </>;
  }
  return <>
    <Panel title={t('Password', '密码')}
      description={t('Change the password used to sign in to your account.', '更改登录密码。')}>
      <TaskFeedback task={passwordTask} />
      <Form className="grid max-w-md gap-4" validationBehavior="native" onSubmit={event => {
        const form = readForm(event);
        const current = form('current');
        const password = form('password');
        void passwordTask.run('save', async () => {
          await call('/account/password', { current, password });
          await refresh();
          return t('Password changed.', '密码已修改。');
        });
      }}>
        <TextField name="current" type="password" autoComplete="current-password" isRequired>
          <Label>{t('Current password', '当前密码')}</Label>
          <Input />
        </TextField>
        <TextField name="password" type="password" autoComplete="new-password" isRequired minLength={12} maxLength={256}>
          <Label>{t('New password', '新密码')}</Label>
          <Input />
        </TextField>
        <div><Button type="submit" isPending={passwordTask.pending === 'save'}>{t('Change password', '修改密码')}</Button></div>
      </Form>
    </Panel>
    <Panel title={t('Two-step verification', '两步验证')}
      description={t('A code from an authenticator app, asked for when you change instance settings.', '来自验证器应用的验证码，在更改实例设置时需要输入。')}>
      {!disableOpen && <TaskFeedback task={task} />}
      {body}
    </Panel>
  </>;
}
