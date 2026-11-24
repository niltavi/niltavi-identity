import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Admin } from './admin';
import { call, codeOf } from './api';
import type { Account, Settings } from './api';
import { Invite, Recover, Register, Reset, SignIn, VerifyEmail, arrive, rememberReturn } from './auth';
import { Setup } from './setup';
import { BrandFooter, BrandHeader, Website, container, copy, pathFor, routeFor } from './site';
import type { Navigate, Route } from './site';
import { AppContext, Loaded } from './ui';
import type { App } from './ui';
import { Workspace } from './workspace';

export { ProtocolPage } from './protocol';

const titles: Partial<Record<Route['section'], [string, string]>> = {
  login: ['Sign in', '登录'], register: ['Create an account', '创建账号'], workspace: ['Account center', '账号中心'],
  recover: ['Reset your password', '重置密码'], reset: ['Choose a new password', '设置新密码'], 'verify-email': ['Verify your email', '验证邮箱'],
  invite: ['Team invitation', '团队邀请'], setup: ['Set up Niltavi Identity', '初始化 Niltavi Identity'], admin: ['Instance console', '实例管理台'],
};

function Identity({ route, navigate }: { route: Route; navigate: Navigate }) {
  const { language, section } = route;
  const [settings, setSettings] = useState<Settings>();
  const [account, setAccount] = useState<Account | null>();
  const [failure, setFailure] = useState<unknown>();

  const refresh = useCallback(async () => {
    try {
      const current = (await call<{ account: Account }>('/account/session')).account;
      setAccount(current);
      return current;
    } catch (error) {
      if (codeOf(error) !== 'sign_in_required') throw error;
      setAccount(null);
      return null;
    }
  }, []);
  const start = useCallback(async () => {
    setFailure(undefined);
    try {
      const [config] = await Promise.all([call<Settings>('/account/config'), refresh()]);
      setSettings(config);
    } catch (error) { setFailure(error); }
  }, [refresh]);
  useEffect(() => { void start(); }, [start]);

  const guarded = section === 'workspace' || section === 'admin';
  useEffect(() => {
    if (account === undefined) return;
    if (account && (section === 'login' || section === 'register' || section === 'recover')) arrive(language, navigate);
    if (!account && guarded) {
      rememberReturn(route);
      navigate({ language, section: 'login' }, true);
    }
  }, [account, guarded, language, navigate, route, section]);

  const app = useMemo<App>(() => ({
    language, navigate, settings, account, t: (en, zh) => language === 'en' ? en : zh,
    refresh: async () => {
      try { return await refresh(); }
      catch { return account ?? null; }
    },
  }), [account, language, navigate, refresh, settings]);

  const waiting = failure !== undefined || account === undefined || (guarded && !account) ||
    (Boolean(account) && (section === 'login' || section === 'register' || section === 'recover'));
  return <AppContext.Provider value={app}>
    {waiting ? <main className={`${container} flex-1 py-8 md:py-12`}>
      <div className="max-w-md"><Loaded source={{ data: undefined, error: failure, reload: start }}>{() => null}</Loaded></div>
    </main>
      : section === 'workspace' ? <Workspace route={route} />
      : section === 'admin' ? <Admin route={route} />
      : <main className={`${container} flex flex-1 justify-center py-8 md:py-12`}>
        <div className="w-full min-w-0">
          <div className={section === 'setup' ? '' : 'mx-auto max-w-[22rem]'}>
            {section === 'login' ? <SignIn /> : section === 'register' ? <Register /> : section === 'recover' ? <Recover />
              : section === 'reset' ? <Reset /> : section === 'verify-email' ? <VerifyEmail /> : section === 'invite' ? <Invite /> : <Setup />}
          </div>
        </div>
      </main>}
  </AppContext.Provider>;
}

export function BrowserApp({ initial }: { initial: Route }) {
  const [route, setRoute] = useState(initial);
  const [interactive, setInteractive] = useState(false);
  const navigate = useCallback<Navigate>((next, replace) => {
    const path = pathFor(next);
    if (path === window.location.pathname + window.location.search) return;
    window.history[replace ? 'replaceState' : 'pushState'](null, '', path);
    setRoute(routeFor(window.location.pathname, window.location.search));
    if (!replace) window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    setInteractive(true);
    const update = () => setRoute(routeFor(window.location.pathname, window.location.search));
    update();
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);

  useLayoutEffect(() => {
    const lang = copy[route.language];
    const title = titles[route.section]?.[route.language === 'en' ? 0 : 1];
    document.documentElement.lang = route.language;
    document.title = title ? `${title} · Niltavi Identity` : lang.title;
    document.querySelector('meta[name=description]')?.setAttribute('content', lang.description);
    document.querySelector('link[rel=canonical]')?.setAttribute('href', new URL(pathFor({ language: route.language, section: route.section }), window.location.origin).href);
    for (const alternate of document.querySelectorAll<HTMLLinkElement>('link[rel=alternate][hreflang]')) {
      const language = alternate.hreflang === 'zh-CN' ? 'zh-CN' : 'en';
      alternate.href = new URL(pathFor({ language, section: route.section }), window.location.origin).href;
    }
    document.querySelector('meta[name=robots]')?.setAttribute('content', route.section === 'home' ? 'index,follow' : 'noindex');
  }, [route]);

  const isHome = route.section === 'home';
  const isAdmin = route.section === 'admin';
  return <div className={`flex flex-col bg-background text-foreground ${isAdmin ? 'admin-shell' : 'min-h-svh'}`}>
    <BrandHeader route={route} navigate={navigate} publicPage={isHome} />
    {isHome ? <Website language={route.language} navigate={navigate} /> : interactive
      ? <Identity route={route} navigate={navigate} />
      : <main className={container + ' flex-1 py-8 md:py-12'} aria-busy="true">
          <p role="status" className="text-muted">{route.language === 'en' ? 'Loading…' : '正在加载…'}</p>
        </main>}
    {!isAdmin && <BrandFooter />}
  </div>;
}
