import { Button, Link, buttonVariants } from '@heroui/react';
import { useLayoutEffect, useState } from 'react';
import { call } from './api';
import type { Account } from './api';
import { SignIn } from './auth';
import { BrandFooter, BrandHeader, container, pathFor } from './site';
import type { Language } from './site';
import { AppContext, AuthLayout } from './ui';

export type ProtocolView = 'login' | 'logout' | 'signed-out' | 'expired';
export type ProtocolData = {
  view: ProtocolView; invalid: boolean; throttled: boolean; registration?: string | undefined; passwordless: boolean;
  language: Language; appName?: string | undefined; appUrl?: string | undefined;
  signInName?: string | undefined; signInLogoUrl?: string | undefined;
};
const languageKey = 'identity.protocol-language';
const refreshAccount = () => call<{ account: Account }>('/account/session').then(result => result.account, () => null);

function chosenLanguage(fallback: Language): Language {
  try {
    const stored = window.sessionStorage.getItem(languageKey);
    return stored === 'en' || stored === 'zh-CN' ? stored : fallback;
  } catch { return fallback; }
}

// Pages inside a sign-in or sign-out request. Their address belongs to the request, so the
// language changes in place and the form posts back to the same path.
export function ProtocolPage({ data }: { data: ProtocolData }) {
  const { view, appName, appUrl } = data;
  const [language, setLanguage] = useState(() => chosenLanguage(data.language));
  const t = (en: string, zh: string) => language === 'en' ? en : zh;
  const title = view === 'login' ? t('Sign in', '登录')
    : view === 'logout' ? t('Sign out of all Niltavi apps in this browser', '退出这个浏览器上的所有 Niltavi 应用')
    : view === 'signed-out' ? t('You are signed out', '你已退出')
    : t('This sign-in request has expired', '登录请求已过期');
  useLayoutEffect(() => {
    document.documentElement.lang = language;
    document.title = data.signInName ? `${title} · ${data.signInName}` : title;
  }, [language, title, data.signInName]);
  function choose(next: Language) {
    try { window.sessionStorage.setItem(languageKey, next); } catch { /* the choice lasts for this page only */ }
    setLanguage(next);
  }
  const header = <BrandHeader route={{ language, section: 'login' }} onLanguage={choose} />;
  if (view === 'login') {
    return <div className="flex min-h-svh flex-col bg-background text-foreground">
      <AuthLayout brand={{ name: data.signInName, logoUrl: data.signInLogoUrl, logoAlt: appName }} controls={header}>
        <AppContext.Provider value={{ language, t, settings: undefined, account: undefined,
          navigate: route => window.location.assign(pathFor(route)), refresh: refreshAccount }}>
          <SignIn interaction={{ path: window.location.pathname, passwordless: data.passwordless, registration: data.registration,
            initialError: data.throttled ? 'try_later' : data.invalid ? 'invalid_credentials' : undefined }} />
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
      </div>
    </main>
    <BrandFooter />
  </div>;
}
