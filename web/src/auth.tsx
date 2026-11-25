import { Button, Checkbox, FieldError, Form, Input, Label, Skeleton, TextField } from '@heroui/react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { RequestFailure, call, codeOf, forgetLinkToken, linkToken, problem } from './api';
import type { AgentToken, Invitation } from './api';
import { CodeField, CredentialsForm, Notice, PageLink, PasswordField, TaskFeedback, passwordLength, readForm, useApp, useTask } from './ui';
import type { Navigate, Route } from './site';
import type { Language } from './site';

const returnKey = 'identity.return';

function pendingInvitation() {
  try { return window.sessionStorage.getItem('identity.link.invite') ?? undefined; } catch { return undefined; }
}

export function rememberReturn(route: Route) {
  try { window.sessionStorage.setItem(returnKey, JSON.stringify({ section: route.section, tab: route.tab, team: route.team })); }
  catch { /* the account center is the fallback */ }
}

// Where a person lands after signing in: the invitation or page they came for, else the account center.
export function arrive(language: Language, navigate: Navigate) {
  if (pendingInvitation()) return navigate({ language, section: 'invite' }, true);
  let back: Partial<Route> = {};
  try {
    back = JSON.parse(window.sessionStorage.getItem(returnKey) ?? '{}') as Partial<Route>;
    window.sessionStorage.removeItem(returnKey);
  } catch { /* the account center is the fallback */ }
  navigate(back.section === 'admin' || back.section === 'workspace'
    ? { language, section: back.section, tab: back.tab, team: back.team } : { language, section: 'workspace' }, true);
}

function Narrow({ title, children }: { title: string; children: ReactNode }) {
  return <section className="niltavi-email-password">
    <h1 className="text-balance text-2xl font-semibold tracking-tight">{title}</h1>
    {children}
  </section>;
}

function Lines() {
  return <div className="niltavi-email-password" aria-busy="true">
    <Skeleton className="h-7 w-2/3 rounded" /><Skeleton className="h-10 w-full rounded" /><Skeleton className="h-10 w-full rounded" />
  </div>;
}

export function SignIn() {
  const { t, language, settings, refresh } = useApp();
  const task = useTask();
  const [mode, setMode] = useState<'password' | 'code'>('password');
  const [codeSentTo, setCodeSentTo] = useState<string>();
  const [codeError, setCodeError] = useState<string>();
  const [emailError, setEmailError] = useState<string>();
  const [pwEmailError, setPwEmailError] = useState<string>();
  const [pwMessage, setPwMessage] = useState<string>();
  const [pwPending, setPwPending] = useState(false);
  const pwBusy = useRef(false);
  const passwordless = settings?.passwordlessAvailable;

  function switchMode(next: 'password' | 'code') {
    if (next === mode) return;
    setMode(next);
    setCodeSentTo(undefined);
    setCodeError(undefined);
    setEmailError(undefined);
    setPwEmailError(undefined);
    setPwMessage(undefined);
    task.setError(undefined);
  }

  const step = mode === 'password' ? 'password' : codeSentTo ? 'verify' : 'email';

  return <section className="niltavi-email-password">
    <h1 className="text-balance text-2xl font-semibold tracking-tight">{t('Sign in', '登录')}</h1>
    {passwordless && <div className="niltavi-auth-modes" role="tablist">
      <button type="button" className="niltavi-auth-mode" role="tab" aria-selected={mode === 'password'}
        onClick={() => switchMode('password')}>{t('Password', '密码登录')}</button>
      <button type="button" className="niltavi-auth-mode" role="tab" aria-selected={mode === 'code'}
        onClick={() => switchMode('code')}>{t('Verification code', '验证码登录')}</button>
    </div>}
    {mode === 'code' && <TaskFeedback task={task} />}
    <div key={step} className="nt-fade-up grid gap-4">
      {step === 'password' && <Form className="niltavi-email-password__form" validationBehavior="native" onSubmit={event => {
        const field = readForm(event);
        if (pwBusy.current) return;
        pwBusy.current = true;
        setPwPending(true);
        setPwEmailError(undefined);
        setPwMessage(undefined);
        void (async () => {
          try {
            await call('/account/login', { email: field('email').trim(), password: field('password') });
            await refresh();
          } catch (failure) {
            if (codeOf(failure) === 'invalid_email') setPwEmailError(problem(failure, language));
            else setPwMessage(problem(failure, language));
          } finally {
            pwBusy.current = false;
            setPwPending(false);
          }
        })();
      }}>
        <fieldset className="niltavi-email-password__fields">
          <TextField name="email" type="email" autoComplete="username" isRequired isInvalid={Boolean(pwEmailError)} onChange={() => setPwEmailError(undefined)}>
            <Label>{t('Email', '邮箱')}</Label>
            <Input className="w-full min-w-0" />
            <FieldError>{pwEmailError}</FieldError>
          </TextField>
          <TextField name="password" type="password" autoComplete="current-password" isRequired>
            <Label>{t('Password', '密码')}</Label>
            <Input className="w-full min-w-0" />
          </TextField>
          <Button type="submit" isPending={pwPending} className="w-full">{t('Sign in', '登录')}</Button>
        </fieldset>
        {pwMessage && <p role="alert">{pwMessage}</p>}
      </Form>}
      {step === 'email' && <Form className="niltavi-email-password__form" validationBehavior="native" onSubmit={event => {
        const email = readForm(event)('email').trim();
        setEmailError(undefined);
        void task.run('send-code', async () => {
          try {
            await call('/account/login-code', { email });
            setCodeSentTo(email);
          } catch (failure) {
            if (codeOf(failure) === 'invalid_email') setEmailError(problem(failure, language));
            else throw failure;
          }
        });
      }}>
        <TextField name="email" type="email" autoComplete="username" isRequired isInvalid={Boolean(emailError)} onChange={() => setEmailError(undefined)}>
          <Label>{t('Email', '邮箱')}</Label>
          <Input className="w-full min-w-0" />
        </TextField>
        {emailError && <p role="alert">{emailError}</p>}
        <Button type="submit" className="w-full" isPending={task.pending === 'send-code'}>{t('Send verification code', '发送验证码')}</Button>
      </Form>}
      {step === 'verify' && <>
        <p className="text-muted wrap-anywhere">{t(`We sent a 6-digit code to ${codeSentTo}. It is valid for 15 minutes.`, `我们向 ${codeSentTo} 发送了 6 位验证码，15 分钟内有效。`)}</p>
        <Form className="niltavi-email-password__form" validationBehavior="native" onSubmit={event => {
          const field = readForm(event);
          setCodeError(undefined);
          void task.run('verify', async () => {
            try {
              await call('/account/login-verify', { code: field('code').trim() });
              await refresh();
            } catch (failure) {
              if (codeOf(failure) !== 'invalid_code') throw failure;
              setCodeError(problem(failure, language));
            }
          });
        }}>
          <CodeField label={t('Verification code', '验证码')} error={codeError} onInput={() => setCodeError(undefined)} />
          <Button type="submit" className="w-full" isPending={task.pending === 'verify'}>{t('Sign in', '登录')}</Button>
        </Form>
        <Button variant="tertiary" size="sm" onPress={() => { setCodeSentTo(undefined); task.setError(undefined); }}>{t('Use a different email', '换一个邮箱')}</Button>
      </>}
    </div>
    <div className="flex flex-wrap gap-x-5 gap-y-2">
      {settings?.registrationAvailable && <PageLink to={{ section: 'register' }}>{t('Create an account', '创建账号')}</PageLink>}
      <PageLink to={{ section: 'recover' }}>{t('Forgot password', '忘记密码')}</PageLink>
    </div>
  </section>;
}

const continuation = /^\/interaction\/[A-Za-z0-9_-]{16,128}\/registered$/;

export function Register() {
  const { t, language, settings, refresh } = useApp();
  const task = useTask();
  const [verifying, setVerifying] = useState<string>();
  const [invited, setInvited] = useState<Invitation | null>();
  const [codeError, setCodeError] = useState<string>();
  const [emailError, setEmailError] = useState<string>();
  const invitation = pendingInvitation();
  const mode = settings?.registrationMode;
  const passwordless = settings?.passwordlessAvailable;

  useEffect(() => {
    if (mode !== 'verify-email') return;
    let current = true;
    void call<{ email: string }>('/account/enrollment').then(({ email }) => { if (current) setVerifying(email); }, () => undefined);
    return () => { current = false; };
  }, [mode]);

  useEffect(() => {
    if (!invitation) return setInvited(null);
    let current = true;
    void call<Invitation>('/account/invitation', { token: invitation }).then(
      found => { if (current) setInvited(found.state === 'pending' ? found : null); }, () => { if (current) setInvited(null); });
    return () => { current = false; };
  }, [invitation]);

  async function finish(continueTo: string | undefined) {
    if (continueTo && continuation.test(continueTo)) return window.location.assign(continueTo);
    await refresh();
  }

  async function autoAcceptInvitation() {
    if (!invitation) return;
    try {
      const joined = await call<{ org: string }>('/account/invitation/accept', { token: invitation });
      forgetLinkToken('invite');
      try { window.sessionStorage.removeItem('identity.link.invite'); } catch { /* ok */ }
      return joined.org;
    } catch { /* invitation may have been consumed or expired; fall through to arrive() */ }
    return undefined;
  }

  const signIn = <PageLink to={{ section: 'login' }}>{t('Sign in instead', '已有账号？登录')}</PageLink>;
  if (!settings || invited === undefined) return <Lines />;
  if (!settings.registrationAvailable) {
    return <Narrow title={t('Create an account', '创建账号')}>
      <Notice status="default">{t('Registration is not open on this instance.', '此实例未开放注册。')}</Notice>
      {signIn}
    </Narrow>;
  }
  const inviteOnly = settings.registrationPolicy === 'invite';
  if (inviteOnly && !invited) {
    return <Narrow title={t('Create an account', '创建账号')}>
      <Notice status="default">{t('This instance is invite-only. Open the invitation link you received to create an account.',
        '此实例仅限受邀注册。请打开你收到的邀请链接来创建账号。')}</Notice>
      {signIn}
    </Narrow>;
  }

  if (verifying) {
    return <Narrow title={t('Check your email', '查收验证码')}>
      <div className="nt-fade-up grid gap-4">
        <p className="text-muted wrap-anywhere">{t(`We sent a 6-digit code to ${verifying}. It is valid for 15 minutes.`, `我们向 ${verifying} 发送了 6 位验证码，15 分钟内有效。`)}</p>
        <TaskFeedback task={task} />
        <Form className="niltavi-email-password__form" validationBehavior="native" onSubmit={event => {
          const field = readForm(event);
          setCodeError(undefined);
          void task.run('verify', async () => {
            try {
              const result = await call<{ continueTo?: string }>('/account/verify', { email: verifying, code: field('code').trim() });
              if (result.continueTo && continuation.test(result.continueTo)) return window.location.assign(result.continueTo);
              await autoAcceptInvitation();
              await refresh();
            } catch (failure) {
              const code = codeOf(failure);
              if (code === 'registration_unavailable' || code === 'invitation_required') setVerifying(undefined);
              if (code !== 'invalid_code') throw failure;
              setCodeError(problem(failure, language));
            }
          });
        }}>
          <CodeField label={t('Verification code', '验证码')} error={codeError} onInput={() => setCodeError(undefined)} />
          <Button type="submit" className="w-full" isPending={task.pending === 'verify'}>{t('Verify and continue', '验证并继续')}</Button>
        </Form>
        <div className="flex flex-wrap gap-2">
          <Button variant="tertiary" size="sm" isPending={task.pending === 'resend'} onPress={() => void task.run('resend', async () => {
            try { await call('/account/resend', {}); }
            catch (failure) {
              if (codeOf(failure) === 'enrollment_expired') setVerifying(undefined);
              throw failure;
            }
            return t('We sent a new code.', '新的验证码已发送。');
          })}>{t('Send a new code', '重新发送')}</Button>
          <Button variant="tertiary" size="sm" onPress={() => { setVerifying(undefined); task.setError(undefined); }}>{t('Use a different email', '换一个邮箱')}</Button>
        </div>
      </div>
    </Narrow>;
  }

  if (passwordless) {
    return <Narrow title={t('Create an account', '创建账号')}>
      {invited && <p className="text-sm text-muted wrap-anywhere">{t(`${invited.inviter} invited ${invited.email} to join ${invited.team}.`,
        `${invited.inviter} 邀请 ${invited.email} 加入 ${invited.team}。`)}</p>}
      {settings.registrationDomain && <p className="text-sm text-muted">{t(`Use an address at @${settings.registrationDomain}.`, `请使用 @${settings.registrationDomain} 的邮箱。`)}</p>}
      <TaskFeedback task={task} />
      <Form className="niltavi-email-password__form" validationBehavior="native" onSubmit={event => {
        const email = readForm(event)('email').trim();
        setEmailError(undefined);
        void task.run('register', async () => {
          try {
            const result = await call<{ created?: true; continueTo?: string }>('/account/register',
              { email, ...(invited && invitation ? { invitation } : {}) });
            if (result.created) await finish(result.continueTo);
            else setVerifying(email);
          } catch (failure) {
            const code = codeOf(failure);
            if (code === 'invalid_email' || code === 'registration_domain' || code === 'email_in_use' || code === 'invitation_required') {
              setEmailError(problem(failure, language));
            } else throw failure;
          }
        });
      }}>
        <TextField name="email" type="email" autoComplete="email" isRequired {...(invited?.email ? { defaultValue: invited.email } : {})}
          isInvalid={Boolean(emailError)} onChange={() => setEmailError(undefined)}>
          <Label>{t('Email', '邮箱')}</Label>
          <Input className="w-full min-w-0" />
        </TextField>
        {emailError && <p role="alert">{emailError}</p>}
        <Button type="submit" className="w-full" isPending={task.pending === 'register'}>{t('Send verification code', '发送验证码')}</Button>
      </Form>
      <div className="flex flex-wrap gap-x-5 gap-y-2">{signIn}</div>
    </Narrow>;
  }

  return <CredentialsForm mode="register" title={t('Create an account', '创建账号')} submit={t('Create account', '创建账号')}
    rule={settings.passwordRule} defaultEmail={invited?.email} validateOnSubmit
    onSubmit={async (email, password) => {
      try {
        const result = await call<{ created?: true; continueTo?: string }>('/account/register',
          { email, password, ...(invited && invitation ? { invitation } : {}) });
        if (result.created) await finish(result.continueTo);
        else setVerifying(email);
      } catch (failure) {
        const code = codeOf(failure);
        if (code === 'invalid_password' || code === 'common_password') return { password: problem(failure, language) };
        if (code === 'invalid_email' || code === 'registration_domain' || code === 'email_in_use' || code === 'invitation_required') {
          return { email: problem(failure, language) };
        }
        return { message: problem(failure, language) };
      }
    }}
    footer={signIn}>
    {invited && <p className="text-sm text-muted wrap-anywhere">{t(`${invited.inviter} invited ${invited.email} to join ${invited.team}.`,
      `${invited.inviter} 邀请 ${invited.email} 加入 ${invited.team}。`)}</p>}
    {settings.registrationDomain && <p className="text-sm text-muted">{t(`Use an address at @${settings.registrationDomain}.`, `请使用 @${settings.registrationDomain} 的邮箱。`)}</p>}
  </CredentialsForm>;
}

export function Recover() {
  const { t, language, settings } = useApp();
  const task = useTask();
  const [sentTo, setSentTo] = useState<string>();
  const [emailError, setEmailError] = useState<string>();
  const back = <PageLink to={{ section: 'login' }}>{t('Back to sign in', '返回登录')}</PageLink>;
  if (!settings) return <Lines />;
  if (!settings.recoveryAvailable) {
    return <Narrow title={t('Reset your password', '重置密码')}>
      <Notice status="default">{t('This instance cannot send mail. Ask its administrator for a password reset link.',
        '此实例无法发送邮件。请联系管理员为你生成密码重置链接。')}</Notice>
      {back}
    </Narrow>;
  }
  if (sentTo) {
    return <Narrow title={t('Check your email', '查收邮件')}>
      <div className="nt-fade-up grid gap-4">
        <p className="wrap-anywhere" role="status">{t(`If ${sentTo} has an account with a verified address, we sent it a link to choose a new password. The link works for 30 minutes.`,
          `如果 ${sentTo} 对应一个邮箱已验证的账号，我们已向它发送了重置密码的链接，30 分钟内有效。`)}</p>
        {back}
      </div>
    </Narrow>;
  }
  return <Narrow title={t('Reset your password', '重置密码')}>
    <TaskFeedback task={task} />
    <Form className="niltavi-email-password__form" validationBehavior="native" onSubmit={event => {
      const email = readForm(event)('email').trim();
      setEmailError(undefined);
      void task.run('recover', async () => {
        try {
          await call('/account/recover', { email });
          setSentTo(email);
        } catch (failure) {
          if (codeOf(failure) !== 'invalid_email') throw failure;
          setEmailError(problem(failure, language));
        }
      });
    }}>
      <TextField name="email" type="email" autoComplete="username" isRequired isInvalid={Boolean(emailError)} onChange={() => setEmailError(undefined)}>
        <Label>{t('Email', '邮箱')}</Label>
        <Input className="w-full min-w-0" />
      </TextField>
      {emailError && <p role="alert">{emailError}</p>}
      <Button type="submit" className="w-full" isPending={task.pending === 'recover'}>{t('Send reset link', '发送重置链接')}</Button>
    </Form>
    {back}
  </Narrow>;
}

export function Reset() {
  const { t, language, settings, refresh } = useApp();
  const task = useTask();
  const [token] = useState(() => linkToken('reset'));
  const [invalid, setInvalid] = useState(!token);
  const [passwordError, setPasswordError] = useState<string>();
  const [tokens, setTokens] = useState<AgentToken[]>();
  const [selected, setSelected] = useState<string[]>([]);
  const rule = settings?.passwordRule ?? { minimum: 12, maximum: 256 };

  if (tokens) {
    return <Narrow title={t('Password changed', '密码已修改')}>
      <p role="status">{t('You are signed in here. Every other device was signed out.', '你已在此浏览器登录，其他设备均已退出。')}</p>
      <TaskFeedback task={task} />
      {tokens.length > 0 && <>
        <p className="text-sm text-muted">{t('These agent tokens still work. Revoke any you do not recognize.', '以下 Agent 令牌仍然有效。如有不认识的，请撤销。')}</p>
        <div className="grid gap-3">
          {tokens.map(entry => <Checkbox key={entry.id} isSelected={selected.includes(entry.id)}
            onChange={on => setSelected(now => on ? [...now, entry.id] : now.filter(id => id !== entry.id))}>
            <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
              <span className="wrap-anywhere">{entry.name} · {entry.appName} · …{entry.hint}</span>
            </Checkbox.Content>
          </Checkbox>)}
        </div>
        <Button variant="danger-soft" isDisabled={!selected.length} isPending={task.pending === 'revoke'} onPress={() => void task.run('revoke', async () => {
          for (const id of selected) await call(`/account/tokens/${encodeURIComponent(id)}/revoke`, {});
          setTokens(now => now?.filter(entry => !selected.includes(entry.id)));
          setSelected([]);
          return t('The selected tokens were revoked.', '所选令牌已撤销。');
        })}>{t('Revoke selected', '撤销所选令牌')}</Button>
      </>}
      <PageLink to={{ section: 'workspace' }}>{t('Continue to your account', '前往账号中心')}</PageLink>
    </Narrow>;
  }
  if (invalid) {
    return <Narrow title={t('This link no longer works', '链接已失效')}>
      <Notice status="danger">{t('The reset link is invalid, expired, or already used.', '重置链接无效、已过期或已使用。')}</Notice>
      <PageLink to={{ section: 'recover' }}>{t('Request a new link', '重新获取链接')}</PageLink>
    </Narrow>;
  }
  return <Narrow title={t('Choose a new password', '设置新密码')}>
    <TaskFeedback task={task} />
    <Form className="niltavi-email-password__form" validationBehavior="native" onSubmit={event => {
      const password = readForm(event)('password');
      if (passwordLength(password) < rule.minimum || passwordLength(password) > rule.maximum) return setPasswordError(problem('invalid_password', language));
      void task.run('reset', async () => {
        try {
          const result = await call<{ agentTokens: AgentToken[] }>('/account/reset', { token: token!, password });
          forgetLinkToken('reset');
          await refresh();
          setTokens(result.agentTokens);
        } catch (failure) {
          const code = codeOf(failure);
          if (code === 'invalid_link') {
            forgetLinkToken('reset');
            setInvalid(true);
          } else if (code === 'invalid_password' || code === 'common_password') setPasswordError(problem(failure, language));
          else throw failure;
        }
      });
    }}>
      <PasswordField label={t('New password', '新密码')} rule={rule} error={passwordError} onInput={() => setPasswordError(undefined)} />
      <Button type="submit" className="w-full" isPending={task.pending === 'reset'}>{t('Change password', '修改密码')}</Button>
    </Form>
  </Narrow>;
}

export function VerifyEmail() {
  const { t, account, refresh } = useApp();
  const [state, setState] = useState<'checking' | 'verified' | 'invalid' | RequestFailure>('checking');
  const started = useRef(false);
  const { language } = useApp();
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = linkToken('verify');
    if (!token) return setState('invalid');
    void call('/account/email/confirm', { token }).then(async () => {
      forgetLinkToken('verify');
      await refresh();
      setState('verified');
    }, (failure: unknown) => {
      if (codeOf(failure) === 'invalid_link') forgetLinkToken('verify');
      setState(codeOf(failure) === 'invalid_link' || !(failure instanceof RequestFailure) ? 'invalid' : failure);
    });
  }, [refresh]);
  if (state === 'checking') return <Lines />;
  if (state === 'verified') {
    return <Narrow title={t('Email verified', '邮箱已验证')}>
      <p role="status">{t('Your email address is confirmed.', '你的邮箱地址已确认。')}</p>
      {pendingInvitation() ? <PageLink to={{ section: 'invite' }}>{t('Continue to your invitation', '继续处理邀请')}</PageLink>
        : account ? <PageLink to={{ section: 'workspace' }}>{t('Go to your account', '前往账号中心')}</PageLink>
        : <PageLink to={{ section: 'login' }}>{t('Sign in', '登录')}</PageLink>}
    </Narrow>;
  }
  return <Narrow title={t('This link no longer works', '链接已失效')}>
    <Notice status="danger">{state === 'invalid' ? t('The verification link is invalid, expired, or already used.', '验证链接无效、已过期或已使用。') : problem(state, language)}</Notice>
    {account ? <PageLink to={{ section: 'workspace' }}>{t('Send a new link from your account', '在账号中心重新发送')}</PageLink>
      : <PageLink to={{ section: 'login' }}>{t('Sign in to send a new link', '登录后重新发送')}</PageLink>}
  </Narrow>;
}

export function Invite() {
  const { t, language, account, settings, navigate, refresh } = useApp();
  const task = useTask();
  const [token] = useState(() => linkToken('invite'));
  const [invitation, setInvitation] = useState<Invitation | null>();
  const [verifyCodeSent, setVerifyCodeSent] = useState(false);
  const [codeError, setCodeError] = useState<string>();
  const [joining, setJoining] = useState(false);
  const autoAccepting = useRef(false);

  useEffect(() => {
    if (!token) return setInvitation(null);
    let current = true;
    void call<Invitation>('/account/invitation', { token }).then(found => { if (current) setInvitation(found); },
      () => { if (current) setInvitation(null); });
    return () => { current = false; };
  }, [token]);

  // Auto-accept when the user is signed in with a verified email and the invitation is pending.
  useEffect(() => {
    if (!account || !invitation || invitation.state !== 'pending' || autoAccepting.current) return;
    if (account.email !== invitation.email || !account.emailVerified) return;
    autoAccepting.current = true;
    setJoining(true);
    void (async () => {
      try {
        const joined = await call<{ org: string }>('/account/invitation/accept', { token: token! });
        forgetLinkToken('invite');
        navigate({ language, section: 'workspace', tab: 'teams', team: joined.org }, true);
      } catch {
        setJoining(false);
        autoAccepting.current = false;
        setInvitation(inv => inv ? { ...inv } : inv);
      }
    })();
  }, [account, invitation, token, language, navigate]);

  if (invitation === undefined || account === undefined || joining) return <Lines />;
  const roles = { owner: t('owner', '所有者'), admin: t('admin', '管理员'), member: t('member', '成员') };
  if (!invitation || invitation.state !== 'pending') {
    if (invitation?.state !== 'accepted') forgetLinkToken('invite');
    return <Narrow title={t('Team invitation', '团队邀请')}>
      <Notice status={invitation?.state === 'accepted' ? 'success' : 'danger'}>{
        invitation?.state === 'accepted' ? t(`This invitation to ${invitation.team} was already accepted.`, `加入 ${invitation.team} 的邀请已被接受。`)
        : invitation?.state === 'revoked' ? t('This invitation was withdrawn. Ask the team for a new one.', '此邀请已被撤回，请联系团队重新邀请。')
        : invitation?.state === 'expired' ? t('This invitation has expired. Ask the team for a new one.', '此邀请已过期，请联系团队重新邀请。')
        : t('This invitation link is not valid.', '邀请链接无效。')}</Notice>
      {account ? <PageLink to={{ section: 'workspace', tab: 'teams' }} onClick={() => forgetLinkToken('invite')}>{t('Go to your teams', '前往我的团队')}</PageLink>
        : <PageLink to={{ section: 'login' }} onClick={() => forgetLinkToken('invite')}>{t('Sign in', '登录')}</PageLink>}
    </Narrow>;
  }
  const summary = <p className="wrap-anywhere">{t(`${invitation.inviter} invited ${invitation.email} to join ${invitation.team} as ${roles[invitation.role]}.`,
    `${invitation.inviter} 邀请 ${invitation.email} 以${roles[invitation.role]}身份加入 ${invitation.team}。`)}</p>;
  const title = t(`Join ${invitation.team}`, `加入 ${invitation.team}`);
  if (!account) {
    return <Narrow title={title}>
      {summary}
      <p className="text-sm text-muted">{t('Sign in or create an account with that email address to accept.', '请使用该邮箱登录或创建账号后接受邀请。')}</p>
      <div className="grid gap-2">
        <Button className="w-full" onPress={() => navigate({ language, section: 'login' })}>{t('Sign in', '登录')}</Button>
        {settings?.registrationAvailable && <Button className="w-full" variant="secondary" onPress={() => navigate({ language, section: 'register' })}>{t('Create an account', '创建账号')}</Button>}
      </div>
    </Narrow>;
  }
  if (account.email !== invitation.email) {
    return <Narrow title={title}>
      {summary}
      <Notice status="warning">{t(`You are signed in as ${account.email}. Sign in as ${invitation.email} to accept.`,
        `你当前登录的是 ${account.email}。请改用 ${invitation.email} 登录后接受邀请。`)}</Notice>
      <TaskFeedback task={task} />
      <Button variant="secondary" className="w-full" isPending={task.pending === 'switch'} onPress={() => void task.run('switch', async () => {
        await call('/account/logout', {});
        await refresh();
      })}>{t('Sign out and switch account', '退出并切换账号')}</Button>
    </Narrow>;
  }
  if (!account.emailVerified) {
    const canSendCode = settings?.passwordlessAvailable;
    return <Narrow title={title}>
      {summary}
      <TaskFeedback task={task} />
      {canSendCode ? <>
        {verifyCodeSent ? <>
          <p className="text-muted wrap-anywhere">{t(`We sent a 6-digit code to ${account.email}.`, `我们向 ${account.email} 发送了 6 位验证码。`)}</p>
          <Form className="niltavi-email-password__form" validationBehavior="native" onSubmit={event => {
            const field = readForm(event);
            setCodeError(undefined);
            void task.run('verify-code', async () => {
              try {
                await call('/account/email/verify-code', { code: field('code').trim() });
                await refresh();
              } catch (failure) {
                if (codeOf(failure) !== 'invalid_code') throw failure;
                setCodeError(problem(failure, language));
              }
            });
          }}>
            <CodeField label={t('Verification code', '验证码')} error={codeError} onInput={() => setCodeError(undefined)} />
            <Button type="submit" className="w-full" isPending={task.pending === 'verify-code'}>{t('Verify and join', '验证并加入')}</Button>
          </Form>
          <Button variant="tertiary" size="sm" isPending={task.pending === 'resend-code'} onPress={() => void task.run('resend-code', async () => {
            await call('/account/email/resend-code', {});
            return t('We sent a new code.', '新的验证码已发送。');
          })}>{t('Send a new code', '重新发送')}</Button>
        </> : <Button className="w-full" isPending={task.pending === 'send-code'} onPress={() => void task.run('send-code', async () => {
          await call('/account/email/verification-code', {});
          setVerifyCodeSent(true);
        })}>{t('Send verification code', '发送验证码')}</Button>}
      </> : <>
        <Notice status="warning">{t('Verify your email address first. An invitation only counts for an address you have confirmed.',
          '请先验证你的邮箱。只有确认过的邮箱才能接受邀请。')}</Notice>
        <Button className="w-full" isPending={task.pending === 'mail'} onPress={() => void task.run('mail', async () => {
          await call('/account/email/verification', {});
          return t(`We sent a verification link to ${account.email}. Open it, then come back to this page.`,
            `验证链接已发送到 ${account.email}。打开链接后再回到本页。`);
        })}>{t('Send verification email', '发送验证邮件')}</Button>
        <Button variant="tertiary" className="w-full" isPending={task.pending === 'check'} onPress={() => void task.run('check', async () => { await refresh(); })}>
          {t('I have verified my email', '我已完成验证')}</Button>
      </>}
    </Narrow>;
  }
  // Email is verified — auto-accept is running (or failed and fell through). Show manual accept button.
  return <Narrow title={title}>
    {summary}
    <TaskFeedback task={task} />
    <Button className="w-full" isPending={task.pending === 'accept'} onPress={() => void task.run('accept', async () => {
      const joined = await call<{ org: string }>('/account/invitation/accept', { token: token! });
      forgetLinkToken('invite');
      navigate({ language, section: 'workspace', tab: 'teams', team: joined.org }, true);
    })}>{t('Accept invitation', '接受邀请')}</Button>
  </Narrow>;
}
