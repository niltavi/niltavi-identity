import { Button, FieldError, Form, Input, Label, Modal, TextField } from '@heroui/react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { RequestFailure, call, codeOf, problem } from './api';
import {
  Choice, CodeField, ConfirmButton, CopyButton, Empty, Loaded, Notice, PasswordField, ResendCodeButton, Section, Setting, State, TaskFeedback,
  readForm, useApp, useLoad, useTask, useTime,
} from './ui';

// Everything about the signed-in account on one page: who it is, how it signs in,
// where it is signed in, and how to delete it.
export function Account() {
  const { t } = useApp();
  return <>
    <Section id="profile" title={t('Profile', '资料')}>
      <Name />
      <Email />
      <LinkLanguage />
    </Section>
    <Section id="security" title={t('Sign-in and security', '登录与安全')}>
      <Password />
      <SecondFactor />
    </Section>
    <Section id="sessions" title={t('Sessions', '登录状态')}>
      <Sessions />
    </Section>
    <Section id="delete" title={t('Delete account', '删除账号')}>
      <Deletion />
    </Section>
  </>;
}

function Name() {
  const { t, account, refresh } = useApp();
  const task = useTask();
  return <Setting title={t('Display name', '显示名称')}>
    <TaskFeedback task={task} />
    <Form className="flex max-w-md flex-wrap items-end gap-3" validationBehavior="native" onSubmit={event => {
      const name = readForm(event)('name');
      void task.run('save', async () => {
        await call('/account/profile', { name });
        await refresh();
        return t('Profile saved.', '个人资料已保存。');
      });
    }}>
      <TextField name="name" defaultValue={account?.name ?? ''} autoComplete="name" aria-label={t('Display name', '显示名称')} className="min-w-0 flex-1 basis-48">
        <Input className="w-full min-w-0" maxLength={80} />
      </TextField>
      <Button type="submit" variant="secondary" isPending={task.pending === 'save'}>{t('Save', '保存')}</Button>
    </Form>
  </Setting>;
}

function Email() {
  const { t, language, account, settings, refresh } = useApp();
  const verify = useTask();
  const change = useTask();
  const [editing, setEditing] = useState(false);
  const [sentTo, setSentTo] = useState<string>();
  const [fieldError, setFieldError] = useState<{ email?: string; password?: string; code?: string }>({});
  if (!account) return null;
  const close = () => { setEditing(false); setSentTo(undefined); setFieldError({}); change.setError(undefined); };
  return <Setting title={t('Email', '邮箱')}>
    <div className="flex flex-wrap items-center gap-2">
      <span className="wrap-anywhere">{account.email}</span>
      <State color={account.emailVerified ? 'success' : 'warning'}>{account.emailVerified ? t('Verified', '已验证') : t('Not verified', '未验证')}</State>
    </div>
    <TaskFeedback task={verify} />
    {!account.emailVerified && !editing && (settings?.recoveryAvailable
      ? <div><Button variant="secondary" size="sm" isPending={verify.pending === 'send'} onPress={() => void verify.run('send', async () => {
        await call('/account/email/verification', {});
        return t(`We sent a verification link to ${account.email}.`, `验证链接已发送到 ${account.email}。`);
      })}>{t('Send verification email', '发送验证邮件')}</Button></div>
      : <Empty>{t('This instance cannot send mail. Ask an administrator to verify your address.', '此实例无法发信，请联系管理员为你验证邮箱。')}</Empty>)}
    <TaskFeedback task={change} />
    {!editing ? settings?.passwordlessAvailable && <div>
      <Button variant="secondary" size="sm" onPress={() => { change.setNotice(undefined); setEditing(true); }}>{t('Change email', '更改邮箱')}</Button>
    </div> : !sentTo ? <Form className="grid max-w-md gap-3" validationBehavior="native" onSubmit={event => {
      const field = readForm(event);
      const email = field('email').trim();
      setFieldError({});
      void change.run('request', async () => {
        try {
          await call('/account/email/change', account.hasPassword ? { email, password: field('password') } : { email });
        } catch (failure) {
          const code = codeOf(failure);
          if (code === 'invalid_email') return setFieldError({ email: problem(failure, language) });
          if (code === 'incorrect_password') return setFieldError({ password: problem(failure, language) });
          throw failure;
        }
        setSentTo(email);
      });
    }}>
      <TextField name="email" type="email" isRequired autoComplete="email" isInvalid={Boolean(fieldError.email)} onChange={() => setFieldError({})}>
        <Label>{t('New email address', '新邮箱地址')}</Label><Input className="w-full min-w-0" /><FieldError>{fieldError.email}</FieldError>
      </TextField>
      {account.hasPassword && <TextField name="password" type="password" isRequired autoComplete="current-password"
        isInvalid={Boolean(fieldError.password)} onChange={() => setFieldError({})}>
        <Label>{t('Current password', '当前密码')}</Label><Input className="w-full min-w-0" /><FieldError>{fieldError.password}</FieldError>
      </TextField>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" isPending={change.pending === 'request'}>{t('Send code', '发送验证码')}</Button>
        <Button size="sm" variant="tertiary" onPress={close}>{t('Cancel', '取消')}</Button>
      </div>
    </Form> : <Form className="grid max-w-sm gap-3" validationBehavior="native" onSubmit={event => {
      const code = readForm(event)('code').trim();
      setFieldError({});
      void change.run('confirm', async () => {
        try { await call('/account/email/change/confirm', { code }); }
        catch (failure) {
          if (codeOf(failure) !== 'invalid_code') throw failure;
          return setFieldError({ code: problem(failure, language) });
        }
        close();
        await refresh();
        return t(`Your email address is now ${sentTo}.`, `邮箱已更改为 ${sentTo}。`);
      });
    }}>
      <p className="text-sm text-muted">{t(`Enter the code we sent to ${sentTo}.`, `请输入发送到 ${sentTo} 的验证码。`)}</p>
      <CodeField label={t('Verification code', '验证码')} error={fieldError.code} onInput={() => setFieldError({})}
        action={<ResendCodeButton isPending={change.pending === 'resend'} onResend={() => void change.run('resend', async () => {
          await call('/account/email/change/resend', {});
        })} />} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" isPending={change.pending === 'confirm'}>{t('Confirm', '确认')}</Button>
        <Button size="sm" variant="tertiary" onPress={close}>{t('Cancel', '取消')}</Button>
      </div>
    </Form>}
  </Setting>;
}

function LinkLanguage() {
  const { account, refresh, t } = useApp();
  const task = useTask();
  return <Setting title={t('Email link language', '邮件链接语言')}
    description={t('For verification and password reset pages opened from an email.', '用于从邮件打开的验证和密码重置页面。')}>
    <TaskFeedback task={task} />
    <Choice hideLabel className="w-full max-w-xs" label={t('Email link language', '邮件链接语言')} value={account?.locale ?? 'browser'}
      isDisabled={task.pending === 'save'} onChange={locale => void task.run('save', async () => {
        await call('/account/preferences', { locale: locale === 'browser' ? '' : locale });
        await refresh();
        return t('Link language saved.', '邮件链接语言已保存。');
      })} options={[
        { id: 'browser', label: t('Same as this browser', '跟随浏览器') }, { id: 'en', label: 'English' }, { id: 'zh-CN', label: '简体中文' }]} />
  </Setting>;
}

function Password() {
  const { t, language, account, settings, refresh } = useApp();
  const task = useTask();
  const [editing, setEditing] = useState(false);
  const [errors, setErrors] = useState<{ current?: string; password?: string }>({});
  if (!account) return null;
  const rule = settings?.passwordRule ?? { minimum: 12, maximum: 256 };
  if (!account.hasPassword) {
    return <Setting title={t('Password', '密码')}>
      <TaskFeedback task={task} />
      <Empty>{t('This account has no password. You sign in with a code sent to your email.', '此账号没有密码，登录时使用发到邮箱的验证码。')}</Empty>
      {settings?.recoveryAvailable && account.emailVerified && <div>
        <Button variant="secondary" size="sm" isPending={task.pending === 'link'} onPress={() => void task.run('link', async () => {
          await call('/account/recover', { email: account.email });
          return t(`We sent a link for setting a password to ${account.email}.`, `设置密码的链接已发送到 ${account.email}。`);
        })}>{t('Set a password', '设置密码')}</Button>
      </div>}
    </Setting>;
  }
  return <Setting title={t('Password', '密码')}>
    <TaskFeedback task={task} />
    {!editing ? <div><Button variant="secondary" size="sm" onPress={() => { task.setNotice(undefined); setEditing(true); }}>{t('Change password', '修改密码')}</Button></div>
      : <Form className="grid max-w-md gap-3" validationBehavior="native" onSubmit={event => {
        const field = readForm(event);
        setErrors({});
        void task.run('save', async () => {
          try { await call('/account/password', { current: field('current'), password: field('password') }); }
          catch (failure) {
            const code = codeOf(failure);
            if (code === 'incorrect_password') return setErrors({ current: problem(failure, language) });
            if (code === 'invalid_password' || code === 'common_password') return setErrors({ password: problem(failure, language) });
            throw failure;
          }
          setEditing(false);
          await refresh();
          return t('Password changed. Your other devices were signed out.', '密码已修改，其他设备已退出登录。');
        });
      }}>
        <TextField name="current" type="password" isRequired autoComplete="current-password" isInvalid={Boolean(errors.current)} onChange={() => setErrors({})}>
          <Label>{t('Current password', '当前密码')}</Label><Input className="w-full min-w-0" /><FieldError>{errors.current}</FieldError>
        </TextField>
        <PasswordField label={t('New password', '新密码')} rule={rule} error={errors.password} onInput={() => setErrors({})} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" isPending={task.pending === 'save'}>{t('Change password', '修改密码')}</Button>
          <Button size="sm" variant="tertiary" onPress={() => { setEditing(false); setErrors({}); task.setError(undefined); }}>{t('Cancel', '取消')}</Button>
        </div>
      </Form>}
  </Setting>;
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

function SecondFactor() {
  const { t, language, account, refresh } = useApp();
  const task = useTask();
  const [setup, setSetup] = useState<{ secret: string; uri: string }>();
  const [codeError, setCodeError] = useState<string>();
  const [disableOpen, setDisableOpen] = useState(false);
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
    body = <div className="flex flex-wrap items-center gap-3">
      <State color="success">{t('On', '已开启')}</State>
      <Modal isOpen={disableOpen} onOpenChange={open => {
        if (pending) return;
        task.setError(undefined);
        setCodeError(undefined);
        setDisableOpen(open);
      }}>
        <Button size="sm" variant="secondary">{t('Manage two-step verification', '管理两步验证')}</Button>
        <Modal.Backdrop isDismissable={!pending} isKeyboardDismissDisabled={pending}>
          <Modal.Container placement="auto">
            <Modal.Dialog className="sm:max-w-md">
              <Modal.Header>
                <Modal.Heading>{t('Turn off two-step verification?', '关闭两步验证？')}</Modal.Heading>
              </Modal.Header>
              <Form className="contents" validationBehavior="native" onSubmit={submitCode('/account/second-factor/disable',
                t('Two-step verification is off.', '两步验证已关闭。'), () => setDisableOpen(false))}>
                <Modal.Body className="grid gap-4">
                  <p className="text-muted">{t('Without it you cannot change instance settings, manage a team’s applications, or enter a team that asks for it.',
                    '关闭后无法更改实例设置、管理团队应用，也无法进入要求两步验证的团队。')}</p>
                  {task.error && <TaskFeedback task={task} />}
                  <CodeField label={t('Current code from your authenticator app', '验证器中的当前验证码')} error={codeError}
                    onInput={() => setCodeError(undefined)} />
                </Modal.Body>
                <Modal.Footer className="flex-wrap">
                  <Button type="button" slot="close" variant="tertiary" isDisabled={pending}>{t('Cancel', '取消')}</Button>
                  <Button type="submit" variant="danger" isPending={pending}>{t('Turn off two-step verification', '关闭两步验证')}</Button>
                </Modal.Footer>
              </Form>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>;
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
    body = <div className="flex flex-wrap items-center gap-3">
      <State>{t('Off', '未开启')}</State>
      <Button size="sm" variant="secondary" isPending={task.pending === 'setup'} onPress={() => void task.run('setup', async () => {
        setSetup(await call<{ secret: string; uri: string }>('/account/second-factor/setup', {}));
      })}>{t('Set up two-step verification', '设置两步验证')}</Button>
    </div>;
  }
  return <Setting title={t('Two-step verification', '两步验证')}
    description={t('A code from an authenticator app, asked for before sensitive changes.', '来自验证器应用的验证码，在进行敏感更改前需要输入。')}>
    {!disableOpen && <TaskFeedback task={task} />}
    {body}
  </Setting>;
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
    <TaskFeedback task={task} />
    <Loaded source={list}>{({ sessions }) => <ul className="grid divide-y divide-separator" aria-label={t('Where you are signed in', '已登录的位置')}>
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
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="min-w-0 flex-1 basis-64 text-sm text-muted">{t('Signing out of all devices ends every session, including all applications. To sign out of one application only, use “Sign out of this app” inside that application.',
        '退出所有设备会结束全部会话，包括所有应用。只想退出某个应用时，请在该应用内使用「退出当前应用」。')}</p>
      <ConfirmButton size="md" label={t('Sign out of all devices', '退出所有设备')} confirm={t('Confirm: sign out everywhere', '确认退出所有设备')} pending={task.pending === 'all'}
        onConfirm={() => void task.run('all', async () => {
          await call('/account/end-sessions', {});
          await refresh();
        })} />
    </div>
  </>;
}

function Deletion() {
  const { t, language, account, refresh } = useApp();
  const time = useTime();
  const task = useTask();
  const [asking, setAsking] = useState(false);
  const [passwordError, setPasswordError] = useState<string>();
  if (!account) return null;
  if (account.deletionRequested) {
    return <>
      <TaskFeedback task={task} />
      <Notice status="warning">{t(`This account will be deleted on ${time(account.deletionAt)}. It works as usual until then.`,
        `此账号将于 ${time(account.deletionAt)} 删除。在此之前账号可以正常使用。`)}</Notice>
      <div><Button variant="secondary" isPending={task.pending === 'change'} onPress={() => void task.run('change', async () => {
        await call('/account/deletion-request', { state: 'withdrawn' });
        await refresh();
        return t('The deletion was cancelled.', '已取消删除。');
      })}>{t('Keep my account', '撤回删除')}</Button></div>
    </>;
  }
  return <>
    <TaskFeedback task={task} />
    <Empty>{t('Deletion happens 7 days after you ask, and you can cancel before then. Afterwards you can no longer sign in, and each application decides what happens to your data there.',
      '提出申请 7 天后删除，期间可以撤回。删除后无法再登录，各应用中的数据由应用自行处理。')}</Empty>
    {!asking ? <div><Button variant="danger-soft" onPress={() => setAsking(true)}>{t('Delete account', '删除账号')}</Button></div>
      : <Form className="grid max-w-md gap-3" validationBehavior="native" onSubmit={event => {
        const password = readForm(event)('password');
        setPasswordError(undefined);
        void task.run('change', async () => {
          try {
            await call('/account/deletion-request', account.hasPassword ? { state: 'requested', password } : { state: 'requested' });
          } catch (failure) {
            if (codeOf(failure) === 'incorrect_password') return setPasswordError(problem(failure, language));
            if (failure instanceof RequestFailure && failure.code === 'sole_team_owner' && Array.isArray(failure.detail.teams)) {
              const teams = failure.detail.teams.map(String).join(t(', ', '、'));
              return task.setError(t(`You are the only owner of ${teams}. Give those teams another owner, or delete them, first.`,
                `你是 ${teams} 的唯一所有者。请先为这些团队指定其他所有者，或删除这些团队。`));
            }
            throw failure;
          }
          setAsking(false);
          await refresh();
        });
      }}>
        {account.hasPassword && <TextField name="password" type="password" isRequired autoComplete="current-password" autoFocus
          isInvalid={Boolean(passwordError)} onChange={() => setPasswordError(undefined)}>
          <Label>{t('Current password', '当前密码')}</Label><Input className="w-full min-w-0" /><FieldError>{passwordError}</FieldError>
        </TextField>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="danger" isPending={task.pending === 'change'}>{t('Confirm deletion', '确认删除')}</Button>
          <Button variant="tertiary" onPress={() => { setAsking(false); setPasswordError(undefined); task.setError(undefined); }}>{t('Cancel', '取消')}</Button>
        </div>
      </Form>}
  </>;
}
