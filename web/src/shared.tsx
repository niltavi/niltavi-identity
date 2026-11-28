import { Button, Form, Input, Label, Table, TextField } from '@heroui/react';
import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { call, codeOf, problem } from './api';
import type { AuditEvent, RegisteredApplication, Team, TeamRole } from './api';
import { CodeField, ConfirmButton, Empty, Loaded, Notice, PageLink, Panel, Secret, State, TaskFeedback, readForm, useApp, useLoad, useTask, useTime } from './ui';

// Pieces the instance console and a team's own pages both use.

// The account's teams, loaded once for the sidebar and shared with the pages that change them.
type Teams = { orgs: Team[] | undefined; reload: () => Promise<void> };
export const TeamsContext = createContext<Teams>({ orgs: undefined, reload: async () => undefined });
export const useTeams = () => useContext(TeamsContext);
export const teamLabel = (team: { name: string; personal: boolean }, t: (en: string, zh: string) => string) => team.personal ? t('Personal space', '个人空间') : team.name;

export function useRoles() {
  const { t } = useApp();
  return { owner: t('Owner', '所有者'), admin: t('Admin', '管理员'), member: t('Member', '成员') } satisfies Record<TeamRole, string>;
}

// Creating or revealing a credential needs a second factor confirmed on this session.
// This asks for the code in place, or points to where two-step verification is turned on.
export function UnlockChanges({ onUnlocked }: { onUnlocked?: () => Promise<void> | void }) {
  const { t, language, account, refresh } = useApp();
  const unlock = useTask();
  const [codeError, setCodeError] = useState<string>();
  if (!account || account.secondFactorVerified) return null;
  if (!account.secondFactorEnabled) {
    return <Notice status="accent" action={<PageLink to={{ section: 'workspace', tab: 'account', hash: 'security' }}>{t('Turn on two-step verification', '开启两步验证')}</PageLink>}>
      {t('You can look around. Making changes needs two-step verification on your account.', '当前只能查看。进行更改需要先为你的账号开启两步验证。')}
    </Notice>;
  }
  return <>
    {unlock.error && <Notice status="danger">{unlock.error}</Notice>}
    <Notice status="accent" action={
      <Form className="flex w-full max-w-sm flex-wrap items-end gap-2" validationBehavior="native" onSubmit={event => {
        const code = readForm(event)('code').trim();
        setCodeError(undefined);
        void unlock.run('unlock', async () => {
          try { await call('/account/second-factor/verify', { code }); }
          catch (failure) {
            if (codeOf(failure) !== 'invalid_code') throw failure;
            return setCodeError(problem(failure, language));
          }
          await refresh();
          await onUnlocked?.();
        });
      }}>
        <div className="min-w-0 flex-1 basis-40"><CodeField label={t('Verification code', '验证码')} error={codeError} onInput={() => setCodeError(undefined)} /></div>
        <Button type="submit" size="md" isPending={unlock.pending === 'unlock'}>{t('Unlock changes', '解锁更改')}</Button>
      </Form>}>
      {t('You can look around. To make changes, enter a code from your authenticator app.', '当前只能查看。要进行更改，请输入验证器中的验证码。')}
    </Notice>
  </>;
}

type Credentials = { client_id: string; client_secret: string };
type ApplicationList = { applications: RegisteredApplication[]; enabled?: boolean; limit?: number };

// Lists the applications behind `base`, and registers, rebrands, disables or removes them.
// The console passes its own endpoints, a team passes the ones under the team.
export function ApplicationManager({ base, canWrite, showOwner, removable, onChanged, children }: {
  base: string; canWrite: boolean; showOwner?: boolean; removable?: boolean; onChanged?: () => Promise<void> | void; children?: ReactNode;
}) {
  const { t, language } = useApp();
  const task = useTask();
  const registering = useTask();
  const brandingTask = useTask();
  const [branding, setBranding] = useState<string>();
  const [issued, setIssued] = useState<Credentials & { fresh: boolean }>();
  const list = useLoad(() => call<ApplicationList>(base), 'applications:' + base);
  const path = (id: string, action: string) => `${base}/${encodeURIComponent(id)}/${action}`;
  const credentials = issued && <Secret title={issued.fresh ? t('Application registered', '应用已注册') : t('New secret created', '已生成新密钥')}
    note={t('Copy the secret into the application now. It is shown only this once.', '请立即把密钥填入应用配置。密钥只在此处显示一次。')} onDone={() => setIssued(undefined)}
    values={[{ label: 'Client ID', value: issued.client_id, name: 'client-id' }, { label: 'Client secret', value: issued.client_secret, name: 'client-secret' }]} />;
  const limit = list.data?.limit;
  const used = list.data?.applications.length ?? 0;
  const closed = list.data?.enabled === false;
  const full = limit !== undefined && used >= limit;
  return <>
    <Panel title={t('Registered applications', '已注册的应用')}
      aside={limit !== undefined && !closed ? <span className="text-sm text-muted tabular-nums">{t(`${used} of ${limit}`, `${used} / ${limit}`)}</span> : undefined}>
      <TaskFeedback task={task} />
      {issued && !issued.fresh && credentials}
      <Loaded source={list}>{({ applications }) => applications.length ? <ul className="grid divide-y divide-separator">
        {applications.map(entry => <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0" data-application={entry.id}>
          <div className="grid min-w-0 gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium wrap-anywhere">{entry.name}</span>
              <State color={entry.enabled ? 'success' : 'danger'}>{entry.enabled ? t('Enabled', '已启用') : t('Disabled', '已停用')}</State>
              {showOwner && entry.team && <State>{t(`Team · ${entry.team}`, `团队 · ${entry.team}`)}</State>}
            </div>
            <p className="text-sm text-muted wrap-anywhere">{entry.id} · {entry.homeUrl}</p>
          </div>
          {canWrite && <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" aria-expanded={branding === entry.id}
              onPress={() => { brandingTask.setError(undefined); setBranding(branding === entry.id ? undefined : entry.id); }}>
              {t('Logo and sign-in name', 'Logo 与登录页名称')}
            </Button>
            <Button size="sm" variant="secondary" isPending={task.pending === entry.id + ':status'} onPress={() => void task.run(entry.id + ':status', async () => {
              await call(path(entry.id, 'status'), { status: entry.enabled ? 'disabled' : 'enabled' });
              await list.reload();
            })}>{entry.enabled ? t('Disable', '停用') : t('Enable', '启用')}</Button>
            <ConfirmButton label={t('New secret', '更换密钥')} confirm={t('Replace the current secret', '确认更换，旧密钥立即失效')} pending={task.pending === entry.id + ':rotate'}
              onConfirm={() => void task.run(entry.id + ':rotate', async () => {
                setIssued({ ...await call<Credentials>(path(entry.id, 'rotate'), {}), fresh: false });
              })} />
            {removable && <ConfirmButton label={t('Delete', '删除')} confirm={t('Delete this application', '确认删除此应用')} pending={task.pending === entry.id + ':delete'}
              onConfirm={() => void task.run(entry.id + ':delete', async () => {
                await call(path(entry.id, 'delete'), {});
                await Promise.all([list.reload(), onChanged?.()]);
                return t(`${entry.name} was deleted.`, `${entry.name} 已删除。`);
              })} />}
          </div>}
          {canWrite && branding === entry.id && <Form className="grid w-full gap-3" validationBehavior="native" onSubmit={event => {
            const field = readForm(event);
            void brandingTask.run('save', async () => {
              await call(path(entry.id, 'branding'), { signInName: field('signInName'), signInLogoUrl: field('signInLogoUrl') });
              await list.reload();
              setBranding(current => current === entry.id ? undefined : current);
            });
          }}>
            <TaskFeedback task={brandingTask} />
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField name="signInName" defaultValue={entry.signInName ?? ''}>
                <Label>{t('Name on sign-in page', '登录页显示名称')}</Label>
                <Input className="w-full min-w-0" maxLength={80} autoComplete="off" />
              </TextField>
              <TextField name="signInLogoUrl" type="url" defaultValue={entry.signInLogoUrl ?? ''}>
                <Label>{t('Logo URL (HTTPS)', 'Logo 地址（HTTPS）')}</Label>
                <Input className="w-full min-w-0" autoComplete="off" />
              </TextField>
            </div>
            <p className="text-sm text-muted">{t('The logo shows on the sign-in page and on the application’s card. Leave both fields empty to show no brand on the sign-in page.',
              'Logo 会显示在登录页和应用卡片上。两项都留空时，登录页不显示应用品牌。')}</p>
            <div><Button type="submit" size="sm" isPending={brandingTask.pending === 'save'}>{t('Save', '保存')}</Button></div>
          </Form>}
        </li>)}
      </ul> : <Empty>{t('No applications are registered yet.', '还没有注册应用。')}</Empty>}</Loaded>
    </Panel>
    {children}
    {closed && <Notice status="default">{problem('team_applications_disabled', language)}</Notice>}
    {canWrite && !closed && <Panel title={t('Register an application', '注册应用')}
      description={t('Identity sends people back to /auth/callback on the application address.', 'Identity 会把用户带回应用地址下的 /auth/callback。')}>
      <TaskFeedback task={registering} />
      {full ? <Empty>{problem('application_limit', language)}</Empty> : <Form className="grid gap-4" validationBehavior="native" onSubmit={event => {
        const field = readForm(event);
        const form = event.currentTarget;
        void registering.run('register', async () => {
          const created = await call<Credentials>(base, { id: field('id').trim(), name: field('name').trim(), homeUrl: field('homeUrl').trim() });
          setIssued({ ...created, fresh: true });
          form.reset();
          await Promise.all([list.reload(), onChanged?.()]);
        });
      }}>
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField name="id" isRequired><Label>{t('Application ID', '应用 ID')}</Label>
            <Input className="w-full min-w-0" pattern="[a-z0-9][a-z0-9-]{2,63}" autoCapitalize="none" spellCheck="false" autoComplete="off" /></TextField>
          <TextField name="name" isRequired><Label>{t('Name', '名称')}</Label><Input className="w-full min-w-0" maxLength={80} autoComplete="off" /></TextField>
          <TextField name="homeUrl" type="url" isRequired><Label>{t('Address (https://…)', '地址（https://…）')}</Label><Input className="w-full min-w-0" autoComplete="off" /></TextField>
        </div>
        <div><Button type="submit" isPending={registering.pending === 'register'}>{t('Register application', '注册应用')}</Button></div>
      </Form>}
      {issued?.fresh && credentials}
    </Panel>}
  </>;
}

const actions: Record<string, [string, string]> = {
  'account.created': ['Account created', '创建账号'], 'account.registered': ['Account registered', '注册账号'],
  'account.email_registered': ['Account registered with verified email', '注册账号并验证邮箱'], 'account.testenv_registered': ['Account registered', '注册账号'],
  'account.deleted': ['Account deleted', '删除账号'], 'account.deletion_requested': ['Deletion requested', '申请删除账号'],
  'account.deletion_withdrawn': ['Deletion request withdrawn', '撤回删除申请'], 'account.email_verified': ['Email verified', '验证邮箱'],
  'account.email_verified_by_operator': ['Email marked as verified', '标记邮箱为已验证'], 'account.email_changed': ['Email address changed', '更改邮箱'],
  'account.password_reset': ['Password reset', '重置密码'], 'account.password_changed': ['Password changed', '修改密码'],
  'account.password_set_by_operator': ['Password set by administrator', '管理员设置密码'],
  'account.recovery_requested': ['Password reset requested', '请求重置密码'], 'account.reset_link_issued': ['Reset link created', '生成重置链接'],
  'account.second_factor_enabled': ['Two-step verification turned on', '开启两步验证'], 'account.second_factor_removed': ['Two-step verification turned off', '关闭两步验证'],
  'account.session_revoked': ['Session ended', '结束会话'], 'account.sessions_ended': ['Signed out of all devices', '退出所有设备'],
  'account.application_revoked': ['Application access revoked', '撤销应用授权'],
  'account.sign_in_failed': ['Sign-in failed', '登录失败'], 'account.signed_in': ['Signed in', '登录'],
  'account.enabled': ['Account enabled', '启用账号'], 'account.disabled': ['Account disabled', '停用账号'],
  'agent_token.issued': ['Agent token created', '创建 Agent 令牌'], 'agent_token.revoked': ['Agent token revoked', '撤销 Agent 令牌'],
  'service_token.issued': ['Service token created', '签发服务令牌'],
  'application.registered': ['Application registered', '注册应用'], 'application.enabled': ['Application enabled', '启用应用'],
  'application.disabled': ['Application disabled', '停用应用'], 'application.secret_rotated': ['Application secret replaced', '更换应用密钥'],
  'application.branding_updated': ['Application logo or name changed', '更改应用 Logo 或名称'], 'application.deleted': ['Application deleted', '删除应用'],
  'instance.admin_granted': ['Administrator added', '添加管理员'], 'instance.admin_revoked': ['Administrator removed', '移除管理员'],
  'instance.initialized': ['Instance set up', '实例完成初始化'], 'instance.mail_configured': ['Outgoing mail configured', '配置发信'],
  'instance.mail_removed': ['Outgoing mail removed', '移除发信配置'], 'instance.registration_changed': ['Registration setting changed', '更改注册设置'],
  'instance.team_applications_changed': ['Team application setting changed', '更改团队应用设置'],
  'team.created': ['Team created', '创建团队'], 'team.renamed': ['Team renamed', '重命名团队'], 'team.member_invited': ['Member invited', '邀请成员'],
  'team.invitation_revoked': ['Invitation withdrawn', '撤回邀请'], 'team.member_joined': ['Member joined', '成员加入'], 'team.member_left': ['Member left', '成员离开'],
  'team.member_removed': ['Member removed', '移除成员'], 'team.member_role_changed': ['Member role changed', '更改成员角色'],
  'team.ownership_transferred': ['Ownership transferred', '转让所有权'], 'team.security_changed': ['Two-step verification rule changed', '更改两步验证要求'],
  'team.deleted': ['Team deleted', '删除团队'],
};

export function AuditTable({ source }: { source: string }) {
  const { t, language } = useApp();
  const time = useTime();
  const list = useLoad(() => call<{ events: AuditEvent[] }>(source), 'audit:' + source);
  return <Panel description={t('The latest 200 events.', '最近 200 条记录。')}>
    <Loaded source={list}>{({ events }) => events.length ? <Table>
      <Table.ScrollContainer className="max-h-[32rem]">
        <Table.Content aria-label={t('Audit log', '审计日志')} className="min-w-[40rem]">
          <Table.Header>
            <Table.Column>{t('Time', '时间')}</Table.Column>
            <Table.Column isRowHeader>{t('Event', '事件')}</Table.Column>
            <Table.Column>{t('By', '操作者')}</Table.Column>
            <Table.Column>{t('On', '对象')}</Table.Column>
          </Table.Header>
          <Table.Body>
            {events.map(event => <Table.Row key={event.id} id={String(event.id)}>
              <Table.Cell className="whitespace-nowrap">{time(event.occurredAt)}</Table.Cell>
              <Table.Cell>{actions[event.action]?.[language === 'en' ? 0 : 1] ?? event.action}</Table.Cell>
              <Table.Cell>{event.actor ?? t('System', '系统')}</Table.Cell>
              <Table.Cell>{event.subject === 'unknown' ? t('Unknown account', '未知账号') : event.subject}</Table.Cell>
            </Table.Row>)}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table> : <Empty>{t('Nothing has been recorded yet.', '还没有记录。')}</Empty>}</Loaded>
  </Panel>;
}
