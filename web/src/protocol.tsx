import { Alert, Button, Form, InputGroup, Label, Link, TextField, buttonVariants } from '@heroui/react';
import Envelope from '@gravity-ui/icons/Envelope';
import Lock from '@gravity-ui/icons/Lock';
import { useLayoutEffect, useState } from 'react';
import { BrandFooter, BrandHeader, container, pathFor } from './site';
import type { Language } from './site';
import { AuthLayout } from './ui';

export type ProtocolView = 'login' | 'logout' | 'signed-out' | 'expired';
export type ProtocolData = {
  view: ProtocolView; invalid: boolean; throttled: boolean; registration?: string | undefined; recover: boolean;
  language: Language; appName?: string | undefined; appUrl?: string | undefined;
  signInName?: string | undefined; signInLogoUrl?: string | undefined;
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
  const problem = data.throttled ? t('Too many attempts. Try again later.', '尝试次数过多，请稍后再试。')
    : data.invalid ? t('The email or password is incorrect.', '邮箱或密码不正确。') : undefined;

  const header = <BrandHeader route={{ language, section: 'login' }} onLanguage={choose} />;
  if (view === 'login') {
    return <div className="flex min-h-svh flex-col bg-background text-foreground">
      <AuthLayout brand={{ name: data.signInName, logoUrl: data.signInLogoUrl, logoAlt: appName }} controls={header}>
        <div className="nt-auth nt-auth--signin">
          <h1 className="nt-auth__title">{title}</h1>
          {problem && <Alert status="danger" role="alert"><Alert.Indicator /><Alert.Content><Alert.Title>{problem}</Alert.Title></Alert.Content></Alert>}
          <Form method="post" action={window.location.pathname} validationBehavior="native" className="nt-auth__form"
            onSubmit={() => setSending(true)}>
            <TextField name="email" type="email" isRequired autoComplete="username">
              <Label>{t('Email', '邮箱')}</Label>
              <InputGroup>
                <InputGroup.Prefix><Envelope aria-hidden="true" width={14} height={14} /></InputGroup.Prefix>
                <InputGroup.Input placeholder="you@example.com" />
              </InputGroup>
            </TextField>
            <TextField name="password" type="password" isRequired autoComplete="current-password">
              <Label>{t('Password', '密码')}</Label>
              <InputGroup>
                <InputGroup.Prefix><Lock aria-hidden="true" width={14} height={14} /></InputGroup.Prefix>
                <InputGroup.Input />
              </InputGroup>
            </TextField>
            <Button type="submit" className="w-full" isPending={sending}>{t('Sign in', '登录')}</Button>
          </Form>
          {(data.registration || data.recover) && <div className="nt-auth__links flex-wrap">
            {data.registration && <Link href={data.registration}>{t('Create an account', '创建账号')}</Link>}
            {data.recover && <Link href={pathFor({ language, section: 'recover' })}>{t('Forgot password', '忘记密码')}</Link>}
          </div>}
        </div>
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
