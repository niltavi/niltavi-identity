import { Button, Form, Link, buttonVariants } from '@heroui/react';
import { useEffect, useLayoutEffect, useState } from 'react';
import { call, codeOf, problem } from './api';
import type { Account, Settings } from './api';
import { Recover, Register, SignIn } from './auth';
import { BrandFooter, BrandHeader, container, pathFor } from './site';
import type { Language, Route } from './site';
import { AppContext, AuthLayout, CodeField, Loaded, readForm, useApp, useLoad } from './ui';

type InteractionView = 'login' | 'register' | 'recover';
export type ProtocolView = InteractionView | 'logout' | 'signed-out' | 'expired' | 'denied' | 'second-factor';
export type ProtocolData = {
  view: ProtocolView; invalid: boolean; throttled: boolean; registration?: string | undefined; passwordless: boolean;
  language: Language; appName?: string | undefined; appUrl?: string | undefined;
  signInName?: string | undefined; signInLogoUrl?: string | undefined;
  interactionPath: string | undefined; loginPath: string | undefined; recoverPath: string | undefined;
  team?: string | undefined; secondFactorEnabled?: boolean;
};
const languageKey = 'identity.protocol-language';
const refreshAccount = () => call<{ account: Account }>('/account/session').then(result => result.account, () => null);

function chosenLanguage(fallback: Language): Language {
  try {
    const stored = window.sessionStorage.getItem(languageKey);
    return stored === 'en' || stored === 'zh-CN' ? stored : fallback;
  } catch { return fallback; }
}

function InteractionForm({ data, view, path }: { data: ProtocolData; view: InteractionView; path: string }) {
  const app = useApp();
  const source = useLoad(() => call<Settings>('/account/config'), 'interaction-settings');
  if (view === 'login') {
    return <SignIn interaction={{ path, passwordless: data.passwordless, registration: data.registration,
      initialError: data.throttled ? 'try_later' : data.invalid ? 'invalid_credentials' : undefined }} />;
  }
  return <Loaded source={source}>{settings => <AppContext.Provider value={{ ...app, settings }}>
    {view === 'register' ? <Register interactionPath={path} /> : <Recover />}
  </AppContext.Provider>}</Loaded>;
}

// The step a team asks for before its application opens: a code from the authenticator app.
function SecondFactorStep({ path, language }: { path: string; language: Language }) {
  const t = (en: string, zh: string) => language === 'en' ? en : zh;
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  async function confirm(code: string) {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const { continueTo } = await call<{ continueTo: string }>(path, { secondFactor: code });
      window.location.assign(continueTo);
    } catch (failure) {
      setError(problem(codeOf(failure) === 'invalid_code' ? failure : codeOf(failure), language));
      setPending(false);
    }
  }
  return <Form className="grid gap-4" validationBehavior="native" onSubmit={event => void confirm(readForm(event)('code').trim())}>
    <CodeField label={t('Code from your authenticator app', '验证器中的验证码')} error={error} onInput={() => setError(undefined)}
      onComplete={code => void confirm(code)} />
    <Button type="submit" isPending={pending} className="w-full">{t('Continue', '继续')}</Button>
  </Form>;
}

// All pages of the authorization request use the same browser-bound interaction.
export function ProtocolPage({ data }: { data: ProtocolData }) {
  const { appName, appUrl, interactionPath, loginPath, registration, recoverPath } = data;
  const [view, setView] = useState(data.view);
  const [language, setLanguage] = useState(() => chosenLanguage(data.language));
  const t = (en: string, zh: string) => language === 'en' ? en : zh;
  const title = view === 'login' ? t('Sign in', '登录')
    : view === 'register' ? t('Create an account', '创建账号')
    : view === 'recover' ? t('Reset your password', '重置密码')
    : view === 'logout' ? t('Sign out of all Niltavi apps in this browser', '退出这个浏览器上的所有 Niltavi 应用')
    : view === 'signed-out' ? t('You are signed out', '你已退出')
    : view === 'denied' ? t(`${appName ?? 'This application'} is for members of its team`, `${appName ?? '这个应用'}只对所属团队的成员开放`)
    : view === 'second-factor' ? t('Two-step verification', '两步验证')
    : t('This sign-in request has expired', '登录请求已过期');
  useLayoutEffect(() => {
    document.documentElement.lang = language;
    document.title = data.signInName ? `${title} · ${data.signInName}` : title;
  }, [language, title, data.signInName]);
  useEffect(() => {
    if (!interactionPath) return;
    function update() {
      const path = window.location.pathname;
      if (path === loginPath) setView('login');
      else if (path === registration) setView('register');
      else if (path === recoverPath) setView('recover');
    }
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, [interactionPath, loginPath, registration, recoverPath]);
  function choose(next: Language) {
    try { window.sessionStorage.setItem(languageKey, next); } catch { /* the choice lasts for this page only */ }
    setLanguage(next);
  }
  const header = <BrandHeader route={{ language, section: 'login' }} onLanguage={choose} />;
  if (interactionPath && (view === 'login' || view === 'register' || view === 'recover')) {
    const paths = { login: loginPath, register: registration, recover: recoverPath };
    const routeHref = (route: Route) => route.section === 'login' || route.section === 'register' || route.section === 'recover'
      ? paths[route.section] ?? pathFor(route) : pathFor(route);
    function navigate(route: Route) {
      const { section } = route;
      if ((section === 'login' || section === 'register' || section === 'recover') && paths[section]) {
        const next = paths[section]!;
        if (window.location.pathname !== next) window.history.pushState(null, '', next);
        setView(section);
      } else window.location.assign(pathFor(route));
    }
    return <div className="flex min-h-svh flex-col bg-background text-foreground">
      <AuthLayout brand={{ name: data.signInName, logoUrl: data.signInLogoUrl, logoAlt: appName }} controls={header}>
        <AppContext.Provider value={{ language, t, settings: undefined, account: undefined, navigate, routeHref, refresh: refreshAccount }}>
          <InteractionForm data={data} view={view} path={interactionPath} />
        </AppContext.Provider>
      </AuthLayout>
    </div>;
  }

  return <div className="flex min-h-svh flex-col bg-background text-foreground">
    {header}
    <main className={`${container} flex-1 py-8 md:py-12`}>
      <div className="niltavi-email-password mx-auto">
        <h1 className="text-balance text-2xl font-semibold tracking-tight">{title}</h1>
        {view === 'logout' && <>
          <p className="text-muted">{t('Applications you opened with this account will ask you to sign in again.', '用这个账号打开的应用会要求你重新登录。')}</p>
          <Button type="submit" variant="danger" form="op.logoutForm" name="logout" value="yes" className="w-full">{t('Sign out', '退出')}</Button>
        </>}
        {view === 'signed-out' && <Link href={pathFor({ language, section: 'home' })}>{t('Go to Identity', '前往 Identity')}</Link>}
        {view === 'expired' && <>
          <p className="text-muted">{t('It took too long, or it was opened in a different browser. Start again from the application.',
            '登录用时过长，或是在另一个浏览器中打开了。请回到应用重新发起登录。')}</p>
          {appName && appUrl && <Link className={buttonVariants({ variant: 'primary' })} href={appUrl}>{t(`Return to ${appName}`, `返回 ${appName}`)}</Link>}
        </>}
        {view === 'denied' && <>
          <p className="text-muted">{data.team
            ? t(`Ask an administrator of ${data.team} to invite you.`, `请联系 ${data.team} 的管理员邀请你加入。`)
            : t('Ask an administrator of the team to invite you.', '请联系团队管理员邀请你加入。')}</p>
          <Link className={buttonVariants({ variant: 'secondary' })} href={pathFor({ language, section: 'workspace' })}>{t('See your applications', '查看我的应用')}</Link>
        </>}
        {view === 'second-factor' && <>
          <p className="text-muted">{data.team
            ? t(`${data.team} asks for two-step verification before ${appName ?? 'this application'} opens.`, `${data.team} 要求先完成两步验证，才能打开${appName ?? '这个应用'}。`)
            : t('This team asks for two-step verification first.', '这个团队要求先完成两步验证。')}</p>
          {data.secondFactorEnabled && interactionPath
            ? <AppContext.Provider value={{ language, t, settings: undefined, account: undefined, navigate: route => window.location.assign(pathFor(route)), refresh: refreshAccount }}>
              <SecondFactorStep path={interactionPath} language={language} />
            </AppContext.Provider>
            : <>
              <p className="text-muted">{t('Turn it on in your account, then open the application again.', '请先在账号页开启两步验证，再重新打开应用。')}</p>
              <Link className={buttonVariants({ variant: 'primary' })} href={pathFor({ language, section: 'workspace', tab: 'account', hash: 'security' })}>
                {t('Turn on two-step verification', '开启两步验证')}</Link>
            </>}
        </>}
      </div>
    </main>
    <BrandFooter />
  </div>;
}
