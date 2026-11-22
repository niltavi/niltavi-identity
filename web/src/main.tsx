import { Alert, Button, Card, Form, Input, Label, Link, TextField } from '@heroui/react';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { BrandFooter, BrandHeader, Website, container } from './site';
import './style.css';

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
type Step = 'login' | 'register' | 'verify';

const errors: Record<string, string> = {
  invalid_email: '请输入有效的邮箱地址。',
  invalid_password: '密码须至少包含 15 个字符，最多 1024 字节。',
  invalid_credentials: '无法登录。请核对邮箱、密码和账号状态。',
  invalid_code: '验证码无效、已过期或已使用。',
  registration_unavailable: '暂时无法注册。已有账号可以登录。',
  registration_domain: '请使用页面上指定的邮箱域名注册。',
  delivery_unavailable: '验证邮件发送失败，请稍后重试。',
  try_later: '尝试次数过多，请稍后重试。',
  account_not_managed: '当前账号无权管理该账号。',
  sign_in_required: '会话已结束，请重新登录。',
};

class RequestFailure extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(errors[code] ?? '服务暂时无法完成请求，请稍后重试。');
  }
}

async function api<T>(path: string, values?: Record<string, string>): Promise<T> {
  const response = await fetch(`/account/${path}`, values === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values),
  });
  if (response.status === 204) return undefined as T;
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new RequestFailure(response.status, result.error ?? 'unexpected_response');
  return result as T;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function ProtocolPage({ view, invalid }: { view: 'login' | 'logout' | 'signed-out'; invalid: boolean }) {
  const title = view === 'login' ? 'Sign in to Niltavi Identity' : view === 'logout' ? 'End the central session' : 'Signed out';
  return <div className="min-h-screen bg-background text-foreground">
    <BrandHeader language="en" />
    <main className={`${container} py-8 md:py-12`}>
      <div className="mx-auto grid max-w-md grid-cols-1 gap-5">
        <h1 className="text-balance text-3xl font-semibold tracking-tight">{title}</h1>
        {invalid && <Alert status="danger"><Alert.Indicator /><Alert.Content>
          <Alert.Title>Credentials were not accepted.</Alert.Title>
        </Alert.Content></Alert>}
        {view === 'login' ? <Card className="min-w-0"><Card.Content className="p-6 sm:p-8">
          <Form method="post" action={window.location.pathname} validationBehavior="native" className="grid grid-cols-1 gap-5">
            <TextField name="email" type="email" isRequired><Label>Email</Label><Input className="min-w-0 w-full" autoComplete="username" /></TextField>
            <TextField name="password" type="password" isRequired><Label>Password</Label><Input className="min-w-0 w-full" autoComplete="current-password" /></TextField>
            <Button type="submit">Sign in</Button>
          </Form>
        </Card.Content></Card> : view === 'logout' ? <Button type="submit" variant="danger"
          form="op.logoutForm" name="logout" value="yes">End session</Button> : <Link href="/">Return to Identity</Link>}
      </div>
    </main>
    <BrandFooter />
  </div>;
}

function Identity() {
  const [settings, setSettings] = useState<Settings>();
  const [account, setAccount] = useState<Account>();
  const [managed, setManaged] = useState<Managed[]>([]);
  const [step, setStep] = useState<Step>(window.location.pathname === '/register' ? 'register' : 'login');
  const [email, setEmail] = useState('');
  const [initializing, setInitializing] = useState(true);
  const [pending, setPending] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: true }>();

  const report = useCallback((error: unknown) => {
    const text = error instanceof RequestFailure ? error.message : '无法连接身份服务，请检查网络后重试。';
    setMessage({ error: true, text });
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

  async function run(work: () => Promise<void>) {
    setPending(true);
    setMessage(undefined);
    try { await work(); }
    catch (error) { report(error); }
    finally { setPending(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const address = email.trim();
    const password = String(fields.get('password') ?? '');
    const verification = String(fields.get('code') ?? '').trim();
    void run(async () => {
      if (step === 'register') {
        await api('register', { email: address });
        setStep('verify');
        setMessage({ text: '请查收验证码，验证码 15 分钟内有效。' });
      } else if (step === 'verify') {
        await api('verify', { email: address, code: verification, password });
        form.reset();
        window.history.replaceState(null, '', '/login');
        setStep('login');
        setMessage({ text: '邮箱已验证，账号已创建。请使用刚设置的密码登录。' });
      } else {
        await api('login', { email: address, password });
        form.reset();
        await refresh(Boolean(settings?.managedAccounts));
      }
    });
  }

  function choose(next: Step) {
    setMessage(undefined);
    setStep(next);
  }

  function logout(all: boolean) {
    void run(async () => {
      await api(all ? 'end-sessions' : 'logout', {});
      setConfirmAll(false);
      setAccount(undefined);
      setManaged([]);
      if (window.location.pathname !== '/login') window.history.replaceState(null, '', '/login');
      setStep('login');
      setMessage({ text: all ? '你的会话已全部结束。' : '你已退出当前会话。' });
    });
  }

  const feedback = message && <Alert status={message.error ? 'danger' : 'success'}>
    <Alert.Indicator /><Alert.Content><Alert.Title>{message.text}</Alert.Title></Alert.Content>
  </Alert>;

  return <div className="min-h-screen bg-background text-foreground">
    <BrandHeader language="zh-CN" />
    <main className={`${container} py-8 md:py-12`}>
      <div className={account ? '' : 'mx-auto max-w-md'}>
      <div className="mb-7 grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            {account ? '我的工作区' : step === 'verify' ? '验证邮箱' : step === 'register' ? '邮箱注册' : '邮箱登录'}
          </h1>
          {account && <Button variant="secondary" isDisabled={pending} onPress={() => logout(false)}>退出</Button>}
        </div>
        {account && <p className="wrap-anywhere text-muted">{account.email}</p>}
      </div>
      <div className="grid grid-cols-1 gap-5">
        {feedback}
        {!account ? <Card className="min-w-0">
          <Card.Content className="p-6 sm:p-8">
            <Form key={step} onSubmit={submit} validationBehavior="native" className="grid grid-cols-1 gap-5">
              {step === 'register' && settings?.registrationDomain && <p className="text-sm text-muted">可使用 @{settings.registrationDomain} 邮箱注册。</p>}
              <TextField name="email" type="email" value={email} onChange={setEmail} isReadOnly={step === 'verify'} isRequired>
                <Label>邮箱</Label><Input className="min-w-0 w-full" autoComplete="username" />
              </TextField>
              {step === 'verify' && <TextField name="code" isRequired>
                <Label>邮箱验证码</Label><Input className="min-w-0 w-full" autoComplete="one-time-code" maxLength={32} /></TextField>}
              {step !== 'register' && <TextField name="password" type="password" isRequired>
                <Label>密码</Label><Input className="min-w-0 w-full" autoComplete={step === 'verify' ? 'new-password' : 'current-password'}
                  minLength={step === 'verify' ? 15 : undefined} /></TextField>}
              <Button type="submit" isPending={pending} isDisabled={initializing || !settings || step === 'register' && !settings.registrationAvailable} className="w-full">
                {step === 'login' ? '登录' : step === 'register' ? '发送验证码' : '验证并创建账号'}
              </Button>
              {step === 'register' && settings && !settings.registrationAvailable && <p className="text-sm text-muted">暂时无法注册。已有账号可以登录。</p>}
            </Form>
            <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-separator pt-5">
              {step === 'login' ? <Link href="/register">邮箱注册</Link> : <Link href="/login">邮箱登录</Link>}
              {step === 'verify' && <Button variant="ghost" isDisabled={pending} onPress={() => choose('register')}>修改邮箱或重发</Button>}
            </div>
          </Card.Content>
        </Card> : <>
          <Card>
            <Card.Header><Card.Title render={(props) => <h2 {...props} />}>当前会话</Card.Title></Card.Header>
            <Card.Content>
              <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                <div><dt className="text-sm text-muted">账号标识</dt><dd className="wrap-anywhere">{account.id}</dd></div>
                <div><dt className="text-sm text-muted">邮箱状态</dt><dd>{account.emailVerified ? '已验证' : '由操作员创建'}</dd></div>
                <div><dt className="text-sm text-muted">本次登录时间</dt><dd>{formatTime(account.signedInAt)}</dd></div>
                <div><dt className="text-sm text-muted">当前会话到期</dt><dd>{formatTime(account.expiresAt)}</dd></div>
                <div><dt className="text-sm text-muted">有效工作区会话</dt><dd>{account.activeSessions}</dd></div>
              </dl>
            </Card.Content>
            <Card.Footer className="flex flex-wrap gap-3">
              <Button variant="secondary" isDisabled={pending} onPress={() => void run(() => refresh(Boolean(settings?.managedAccounts)))}>刷新会话</Button>
              {confirmAll ? <>
                <Button variant="danger" isDisabled={pending} onPress={() => logout(true)}>确认结束全部会话</Button>
                <Button variant="ghost" isDisabled={pending} onPress={() => setConfirmAll(false)}>取消</Button>
              </> : <Button variant="ghost" isDisabled={pending} onPress={() => setConfirmAll(true)}>结束我的全部会话</Button>}
            </Card.Footer>
          </Card>
          {Boolean(settings?.applications.length) && <Card>
            <Card.Header><Card.Title render={(props) => <h2 {...props} />}>已接入应用</Card.Title></Card.Header>
            <Card.Content className="flex flex-wrap gap-3">
              {settings?.applications.map(({ name, url }) => <Link key={url} href={url} target="_blank" rel="noreferrer">{name}</Link>)}
            </Card.Content>
          </Card>}
          {managed.length > 0 && <Card>
            <Card.Header><Card.Title render={(props) => <h2 {...props} />}>账号管理</Card.Title></Card.Header>
            <Card.Content><ul className="divide-y divide-separator">
              {managed.map((entry) => <li key={entry.id} className="flex flex-wrap items-center justify-between gap-4 py-3">
                <div className="wrap-anywhere"><p>{entry.email}</p><p className="text-sm text-muted">{entry.enabled ? '已启用' : '已停用'}</p></div>
                <Button variant={entry.enabled ? 'danger-soft' : 'secondary'} isDisabled={pending}
                  onPress={() => void run(async () => {
                    const result = await api<{ changed: boolean; enabled: boolean }>(`managed/${encodeURIComponent(entry.id)}/status`,
                      { status: entry.enabled ? 'disabled' : 'enabled' });
                    await refresh(true);
                    setMessage({ text: result.changed ? (result.enabled ? '该账号已启用。' : '该账号已停用，既有会话已失效。') : '该账号已处于所选状态。' });
                  })}>{entry.enabled ? '停用账号' : '启用账号'}</Button>
              </li>)}
            </ul></Card.Content>
          </Card>}
        </>}
      </div>
      </div>
    </main>
    <BrandFooter />
  </div>;
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing Identity application root.');
const screen = root.dataset.protocol;
if (screen) document.documentElement.lang = 'en';
createRoot(root).render(screen === 'login' || screen === 'logout' || screen === 'signed-out'
  ? <ProtocolPage view={screen} invalid={root.dataset.invalid === 'true'} />
  : window.location.pathname === '/' ? <Website /> : <Identity />);
