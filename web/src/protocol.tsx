import { Alert, Button, Form, Input, Label, Link, TextField, buttonVariants } from '@heroui/react';
import { useLayoutEffect, useState } from 'react';
import { BrandFooter, BrandHeader, container, pathFor } from './site';
import type { Language } from './site';

export type ProtocolView = 'login' | 'logout' | 'signed-out' | 'expired';
export type ProtocolData = {
  view: ProtocolView; invalid: boolean; throttled: boolean; registration?: string | undefined; recover: boolean;
  language: Language; appName?: string | undefined; appUrl?: string | undefined;
};
const languageKey = 'identity.protocol-language';

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
  const [sending, setSending] = useState(false);
  const t = (en: string, zh: string) => language === 'en' ? en : zh;
  const title = view === 'login' ? appName ? t(`Sign in to continue to ${appName}`, `登录以继续使用 ${appName}`) : t('Sign in to Niltavi Identity', '登录 Niltavi Identity')
    : view === 'logout' ? t('Sign out of all Niltavi apps in this browser', '退出这个浏览器上的所有 Niltavi 应用')
    : view === 'signed-out' ? t('You are signed out', '你已退出')
    : t('This sign-in request has expired', '登录请求已过期');
  useLayoutEffect(() => {
    document.documentElement.lang = language;
    document.title = title;
  }, [language, title]);
  function choose(next: Language) {
    try { window.sessionStorage.setItem(languageKey, next); } catch { /* the choice lasts for this page only */ }
    setLanguage(next);
  }
  const problem = data.throttled ? t('Too many attempts. Try again later.', '尝试次数过多，请稍后再试。')
    : data.invalid ? t('The email or password is incorrect.', '邮箱或密码不正确。') : undefined;

  return <div className="flex min-h-svh flex-col bg-background text-foreground">
    <BrandHeader route={{ language, section: 'login' }} onLanguage={choose} />
    <main className={`${container} flex-1 py-8 md:py-12`}>
      <div className="niltavi-email-password mx-auto">
        <h1 className="text-balance text-2xl font-semibold tracking-tight">{title}</h1>
        {view === 'login' && <>
          {problem && <Alert status="danger" role="alert"><Alert.Indicator /><Alert.Content><Alert.Title>{problem}</Alert.Title></Alert.Content></Alert>}
          <Form method="post" action={window.location.pathname} validationBehavior="native" className="niltavi-email-password__form"
            onSubmit={() => setSending(true)}>
            <div className="niltavi-email-password__fields">
              <TextField name="email" type="email" isRequired autoComplete="username">
                <Label>{t('Email', '邮箱')}</Label><Input className="w-full min-w-0" />
              </TextField>
              <TextField name="password" type="password" isRequired autoComplete="current-password">
                <Label>{t('Password', '密码')}</Label><Input className="w-full min-w-0" />
              </TextField>
              <Button type="submit" className="w-full" isPending={sending}>{t('Sign in', '登录')}</Button>
            </div>
          </Form>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {data.registration && <Link href={data.registration}>{t('Create an account', '创建账号')}</Link>}
            {data.recover && <Link href={pathFor({ language, section: 'recover' })}>{t('Forgot password', '忘记密码')}</Link>}
          </div>
        </>}
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
