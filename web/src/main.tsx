import { Alert, Button, Card, Form, Input, Label, Link, TextField } from '@heroui/react';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { BrandFooter, BrandHeader, RouteLink, Website, container, copy, followRoute, pathFor, routeFor } from './site';
import type { Language, Navigate, Route } from './site';
import { EmailPasswordForm } from '../vendor/niltavi-ui/product/EmailPasswordForm';

type Account = {
  id: string;
  email: string;
  emailVerified: boolean;
  signedInAt: string;
  expiresAt: string;
  activeSessions: number;
};
type Managed = { id: string; email: string; enabled: boolean };
type Settings = {
  registrationAvailable: boolean;
  registrationDomain?: string;
  managedAccounts: boolean;
  applications: Array<{ name: string; url: string }>;
};

const notices: Record<string, [string, string]> = {
  invalid_email: ['Enter a valid email address.', '请输入有效的邮箱地址。'],
  invalid_password: ['Use at least 15 characters and at most 1024 bytes.', '密码须至少包含 15 个字符，最多 1024 字节。'],
  invalid_credentials: ['Check your email, password, and account status.', '无法登录。请核对邮箱、密码和账号状态。'],
  invalid_code: ['The code is invalid, expired, or already used. Enter it in the browser where you started registration.', '验证码无效、已过期或已使用。请在发起注册的浏览器中输入。'],
  registration_unavailable: ['Registration is temporarily unavailable. Existing accounts can sign in.', '暂时无法注册。已有账号可以登录。'],
  registration_domain: ['Use the test mailbox domain shown on this page.', '请使用页面上指定的邮箱域名注册。'],
  delivery_unavailable: ['The verification email could not be sent. Try again later.', '验证邮件发送失败，请稍后重试。'],
  try_later: ['Too many attempts. Try again later.', '尝试次数过多，请稍后重试。'],
  account_not_managed: ['You do not have permission to manage this account.', '当前账号无权管理该账号。'],
  sign_in_required: ['Your session ended. Sign in again.', '会话已结束，请重新登录。'],
  unexpected_response: ['Identity could not complete the request. Try again.', '服务暂时无法完成请求，请稍后重试。'],
  connection_failed: ['Could not connect to Identity. Check your connection and try again.', '无法连接身份服务，请检查网络后重试。'],
  code_sent: ['Check your email. The code is valid for 15 minutes.', '请查收验证码，验证码 15 分钟内有效。'],
  verified: ['Your email is verified. Sign in with the password you chose.', '邮箱已验证，账号已创建。请使用刚设置的密码登录。'],
  ended: ['All your sessions have ended.', '你的会话已全部结束。'],
  signed_out: ['You have signed out of this session.', '你已退出当前会话。'],
  enabled: ['The account is enabled.', '该账号已启用。'],
  disabled: ['The account is disabled and its prior sessions have ended.', '该账号已停用，既有会话已失效。'],
  unchanged: ['The account already has that status.', '该账号已处于所选状态。'],
};

class RequestFailure extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

async function api<T>(path: string, values?: Record<string, string>): Promise<T> {
  const response = await fetch('/account/' + path, values === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values),
  });
  if (response.status === 204) return undefined as T;
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new RequestFailure(response.status, result.error ?? 'unexpected_response');
  return result as T;
}

export function ProtocolPage({ view, invalid }: { view: 'login' | 'logout' | 'signed-out'; invalid: boolean }) {
  const title = view === 'login' ? 'Sign in to Niltavi Identity' : view === 'logout' ? 'End the central session' : 'Signed out';
  return <div className="flex min-h-svh flex-col bg-background text-foreground">
    <BrandHeader route={{ language: 'en', section: 'login' }} />
    <main className={`${container} flex-1 py-8 md:py-12`}>
      <div className="mx-auto grid max-w-md gap-5">
        <h1 className="text-balance text-3xl font-semibold tracking-tight">{title}</h1>
        {invalid && <Alert status="danger"><Alert.Indicator /><Alert.Content>
          <Alert.Title>Credentials were not accepted.</Alert.Title>
        </Alert.Content></Alert>}
        {view === 'login' ? <Card className="min-w-0"><Card.Content className="p-6 sm:p-8">
          <Form method="post" action={window.location.pathname} validationBehavior="native" className="grid gap-5">
            <TextField name="email" type="email" isRequired><Label>Email</Label><Input className="min-w-0 w-full" autoComplete="username" /></TextField>
            <TextField name="password" type="password" isRequired><Label>Password</Label><Input className="min-w-0 w-full" autoComplete="current-password" /></TextField>
            <Button type="submit">Sign in</Button>
          </Form>
          <Link href="/register" className="mt-5">Register by email</Link>
        </Card.Content></Card> : view === 'logout' ? <Button type="submit" variant="danger"
          form="op.logoutForm" name="logout" value="yes">End session</Button> : <Link href="/">Return to Identity</Link>}
      </div>
    </main>
    <BrandFooter />
  </div>;
}

function Identity({ route, navigate }: { route: Route; navigate: Navigate }) {
  const { language, section } = route;
  const text = (en: string, zh: string) => language === 'en' ? en : zh;
  const label = (key: string) => (notices[key] ?? notices.unexpected_response)![language === 'en' ? 0 : 1];
  const [settings, setSettings] = useState<Settings>();
  const [account, setAccount] = useState<Account>();
  const [managed, setManaged] = useState<Managed[]>([]);
  const [verifying, setVerifying] = useState(false);
  const [email, setEmail] = useState('');
  const [initializing, setInitializing] = useState(true);
  const [pending, setPending] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [message, setMessage] = useState<{ code: string; error?: true }>();
  const step = section === 'register' ? verifying ? 'verify' : 'register' : 'login';
  const destination = (section: Route['section']): Route => ({ language, section });

  const report = useCallback((error: unknown) => {
    setMessage({ error: true, code: error instanceof RequestFailure ? error.code : 'connection_failed' });
  }, []);

  const refresh = useCallback(async (manage: boolean) => {
    try {
      const result = await api<{ account: Account }>('session');
      setAccount(result.account);
      if (manage) setManaged((await api<{ accounts: Managed[] }>('managed')).accounts);
    } catch (error) {
      if (error instanceof RequestFailure && error.status === 401) {
        setAccount(undefined);
        setManaged([]);
        return;
      }
      throw error;
    }
  }, []);

  useEffect(() => {
    void api<Settings>('config').then(async (value) => {
      setSettings(value);
      await refresh(value.managedAccounts);
    }).catch(report).finally(() => setInitializing(false));
  }, [refresh, report]);

  useEffect(() => {
    if (initializing) return;
    if (account && section !== 'workspace') navigate({ language, section: 'workspace' }, true);
    if (!account && section === 'workspace') navigate({ language, section: 'login' }, true);
  }, [account, initializing, language, navigate, section]);

  useEffect(() => { if (section !== 'register') setVerifying(false); }, [section]);

  async function run(work: () => Promise<void>) {
    setPending(true);
    setMessage(undefined);
    try { await work(); }
    catch (error) { report(error); }
    finally { setPending(false); }
  }

  async function submitCredentials({ email: address, password }: { email: string; password: string }) {
    setMessage(undefined);
    setEmail(address);
    try {
      if (step === 'register') {
        await api('register', { email: address, password });
        setVerifying(true);
        setMessage({ code: 'code_sent' });
      } else {
        await api('login', { email: address, password });
        await refresh(Boolean(settings?.managedAccounts));
      }
    } catch (error) {
      const code = error instanceof RequestFailure ? error.code : 'connection_failed';
      if (code === 'invalid_password') return { password: label(code) };
      if (code === 'invalid_email' || code === 'registration_domain') return { email: label(code) };
      return { message: label(code) };
    }
  }

  function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const code = String(fields.get('code') ?? '').trim();
    void run(async () => {
      await api('verify', { email, code });
      form.reset();
      setVerifying(false);
      navigate(destination('login'), true);
      setMessage({ code: 'verified' });
    });
  }

  function logout(all: boolean) {
    void run(async () => {
      await api(all ? 'end-sessions' : 'logout', {});
      setConfirmAll(false);
      setAccount(undefined);
      setManaged([]);
      setMessage({ code: all ? 'ended' : 'signed_out' });
    });
  }

  function formatTime(value: string) {
    return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  }

  const feedback = message && <Alert status={message.error ? 'danger' : 'success'}>
    <Alert.Indicator /><Alert.Content><Alert.Title>{label(message.code)}</Alert.Title></Alert.Content>
  </Alert>;
  const heading = account || section === 'workspace' ? text('My workspace', '我的工作区')
    : step === 'verify' ? text('Verify email', '验证邮箱') : step === 'register' ? text('Register by email', '邮箱注册') : text('Sign in by email', '邮箱登录');
  const alternate = destination(step === 'login' ? 'register' : 'login');

  return <main className={`${container} flex-1 py-8 md:py-12`}>
    <div className={account ? '' : 'mx-auto max-w-md'}>
      {(account || section === 'workspace' || step === 'verify') && <div className="mb-7 grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">{heading}</h1>
          {account && <Button variant="secondary" isDisabled={pending} onPress={() => logout(false)}>{text('Sign out', '退出')}</Button>}
        </div>
        {account && <p className="wrap-anywhere text-muted">{account.email}</p>}
      </div>}
      <div className="grid gap-5">
        {feedback}
        {section === 'workspace' && !account ? <p role="status" className="text-muted">{text('Checking your session…', '正在检查会话…')}</p>
          : !account ? step === 'verify' ? <Card className="min-w-0">
          <Card.Content className="p-6 sm:p-8">
            <Form method="post" onSubmit={submitCode} validationBehavior="native" className="grid gap-5">
              <TextField name="email" type="email" value={email} isReadOnly isRequired>
                <Label>{text('Email', '邮箱')}</Label><Input className="min-w-0 w-full" autoComplete="username" />
              </TextField>
              <TextField name="code" isRequired>
                <Label>{text('Verification code', '邮箱验证码')}</Label>
                <Input className="min-w-0 w-full" autoComplete="one-time-code" maxLength={32} />
              </TextField>
              <Button type="submit" isPending={pending} className="w-full">
                {text('Verify and create account', '验证并创建账号')}
              </Button>
            </Form>
            <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-separator pt-5">
              <RouteLink route={alternate} navigate={navigate} onClick={() => setMessage(undefined)}>
                {text('Sign in by email', '邮箱登录')}
              </RouteLink>
              <Button variant="ghost" isDisabled={pending} onPress={() => { setVerifying(false); setMessage(undefined); }}>
                {text('Change email or resend', '修改邮箱或重发')}
              </Button>
            </div>
          </Card.Content>
        </Card> : <fieldset className="m-0 min-w-0 border-0 p-0" disabled={initializing || !settings ||
            step === 'register' && !settings.registrationAvailable}>
          <EmailPasswordForm key={step} mode={step === 'register' ? 'register' : 'sign-in'}
            labels={{ title: heading, email: text('Email', '邮箱'), password: text('Password', '密码'),
              retry: label('connection_failed') }}
            alternate={{ href: pathFor(alternate), label: step === 'register' ? text('Sign in by email', '邮箱登录') : text('Register by email', '邮箱注册'),
              onClick: event => { setMessage(undefined); followRoute(event, alternate, navigate); } }}
            onSubmit={submitCredentials}>
            {step === 'register' && settings?.registrationDomain &&
              <p className="text-sm text-muted">{text('Test mailbox domain', '验收邮箱域名')} @{settings.registrationDomain}</p>}
            {step === 'register' && settings && !settings.registrationAvailable && <p className="text-sm text-muted">{label('registration_unavailable')}</p>}
          </EmailPasswordForm>
        </fieldset> : <>
          <Card>
            <Card.Header><Card.Title render={props => <h2 {...props} />}>{text('Current session', '当前会话')}</Card.Title></Card.Header>
            <Card.Content>
              <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                <div><dt className="text-sm text-muted">{text('Account ID', '账号标识')}</dt><dd className="wrap-anywhere">{account.id}</dd></div>
                <div><dt className="text-sm text-muted">{text('Email status', '邮箱状态')}</dt><dd>{account.emailVerified ? text('Verified', '已验证') : text('Operator-created', '由操作员创建')}</dd></div>
                <div><dt className="text-sm text-muted">{text('Signed in at', '本次登录时间')}</dt><dd>{formatTime(account.signedInAt)}</dd></div>
                <div><dt className="text-sm text-muted">{text('Session expires', '当前会话到期')}</dt><dd>{formatTime(account.expiresAt)}</dd></div>
                <div><dt className="text-sm text-muted">{text('Active workspace sessions', '有效工作区会话')}</dt><dd>{account.activeSessions}</dd></div>
              </dl>
            </Card.Content>
            <Card.Footer className="flex flex-wrap gap-3">
              <Button variant="secondary" isDisabled={pending} onPress={() => void run(() => refresh(Boolean(settings?.managedAccounts)))}>{text('Refresh sessions', '刷新会话')}</Button>
              {confirmAll ? <>
                <Button variant="danger" isDisabled={pending} onPress={() => logout(true)}>{text('Confirm ending all sessions', '确认结束全部会话')}</Button>
                <Button variant="ghost" isDisabled={pending} onPress={() => setConfirmAll(false)}>{text('Cancel', '取消')}</Button>
              </> : <Button variant="ghost" isDisabled={pending} onPress={() => setConfirmAll(true)}>{text('End all my sessions', '结束我的全部会话')}</Button>}
            </Card.Footer>
          </Card>
          {Boolean(settings?.applications.length) && <Card>
            <Card.Header><Card.Title render={props => <h2 {...props} />}>{text('Connected apps', '已接入应用')}</Card.Title></Card.Header>
            <Card.Content className="flex flex-wrap gap-3">
              {settings?.applications.map(({ name, url }) => <Link key={url} href={url} target="_blank" rel="noreferrer">{name}</Link>)}
            </Card.Content>
          </Card>}
          {managed.length > 0 && <Card>
            <Card.Header><Card.Title render={props => <h2 {...props} />}>{text('Manage accounts', '账号管理')}</Card.Title></Card.Header>
            <Card.Content><ul className="divide-y divide-separator">
              {managed.map(entry => <li key={entry.id} className="flex flex-wrap items-center justify-between gap-4 py-3">
                <div className="wrap-anywhere"><p>{entry.email}</p><p className="text-sm text-muted">{entry.enabled ? text('Enabled', '已启用') : text('Disabled', '已停用')}</p></div>
                <Button variant={entry.enabled ? 'danger-soft' : 'secondary'} isDisabled={pending}
                  onPress={() => void run(async () => {
                    const result = await api<{ changed: boolean; enabled: boolean }>('managed/' + encodeURIComponent(entry.id) + '/status',
                      { status: entry.enabled ? 'disabled' : 'enabled' });
                    await refresh(true);
                    setMessage({ code: result.changed ? result.enabled ? 'enabled' : 'disabled' : 'unchanged' });
                  })}>{entry.enabled ? text('Disable account', '停用账号') : text('Enable account', '启用账号')}</Button>
              </li>)}
            </ul></Card.Content>
          </Card>}
        </>}
      </div>
    </div>
  </main>;
}

export function BrowserApp({ initial }: { initial: Route }) {
  const [route, setRoute] = useState(initial);
  const [interactive, setInteractive] = useState(false);
  const navigate = useCallback<Navigate>((next, replace) => {
    const path = pathFor(next);
    if (path === window.location.pathname) return;
    window.history[replace ? 'replaceState' : 'pushState'](null, '', path);
    setRoute(next);
  }, []);

  useEffect(() => {
    setInteractive(true);
    const update = () => setRoute(routeFor(window.location.pathname));
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);

  useLayoutEffect(() => {
    const lang = copy[route.language];
    document.documentElement.lang = route.language;
    document.title = lang.title;
    document.querySelector('meta[name=description]')?.setAttribute('content', lang.description);
    document.querySelector('link[rel=canonical]')?.setAttribute('href', new URL(pathFor(route), window.location.origin).href);
    for (const alternate of document.querySelectorAll<HTMLLinkElement>('link[rel=alternate][hreflang]')) {
      const language = alternate.hreflang === 'zh-CN' ? 'zh-CN' : 'en';
      alternate.href = new URL(pathFor({ language, section: route.section }), window.location.origin).href;
    }
    document.querySelector('meta[name=robots]')?.setAttribute('content', route.section === 'home' ? 'index,follow' : 'noindex');
  }, [route]);

  const isHome = route.section === 'home';
  return <div className="flex min-h-svh flex-col bg-background text-foreground">
    <BrandHeader route={route} navigate={navigate} publicPage={isHome} />
    {isHome ? <Website language={route.language} navigate={navigate} /> : interactive
      ? <Identity route={route} navigate={navigate} />
      : <main className={container + ' flex-1 py-8 md:py-12'} aria-busy="true">
          <p role="status" className="text-muted">{route.language === 'en' ? 'Loading Identity…' : '正在加载 Identity…'}</p>
        </main>}
    <BrandFooter />
  </div>;
}
