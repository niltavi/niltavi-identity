import { Button, Link, buttonVariants } from '@heroui/react';
import Globe from '@gravity-ui/icons/Globe';
import LogoGithub from '@gravity-ui/icons/LogoGithub';
import Moon from '@gravity-ui/icons/Moon';
import ShieldCheck from '@gravity-ui/icons/ShieldCheck';
import Sun from '@gravity-ui/icons/Sun';
import { useLayoutEffect, useState } from 'react';
import guide from '../../docs/en/for-agents.md?url&no-inline';
import wordmarkLight from './brand/niltavi-logo-light.svg';
import wordmarkDark from './brand/niltavi-logo-dark.svg';

export const container = 'mx-auto w-full px-4 sm:max-w-[540px] md:max-w-[720px] lg:max-w-[960px] xl:max-w-[1140px] 2xl:max-w-[1320px]';

const repository = 'https://github.com/niltavi/niltavi-identity';
const themePreference = window.matchMedia('(prefers-color-scheme: dark)');
type Theme = 'light' | 'dark';
type Language = 'en' | 'zh-CN';

const copy = {
  en: {
    heading: 'One account for your apps',
    description: 'Connect your apps with OpenID Connect. Users sign in once and can view or end their sessions in one place.',
    signIn: 'Email sign-in', register: 'Register by email', install: 'Install with an agent',
    dark: 'Switch to dark theme', light: 'Switch to light theme', language: '切换到简体中文', github: 'GitHub repository',
  },
  'zh-CN': {
    heading: <>一个账号，<wbr /><span className="whitespace-nowrap">登录多个应用</span></>,
    description: '通过 OpenID Connect 接入你的应用。用户登录一次即可访问已接入的应用，并集中查看或结束自己的会话。',
    signIn: '邮箱登录', register: '邮箱注册', install: '交给 Agent 安装',
    dark: '切换到深色主题', light: '切换到浅色主题', language: 'Switch to English', github: 'GitHub 仓库',
  },
};

function useTheme() {
  const [choice, setChoice] = useState<Theme | null>(() => {
    const value = localStorage.getItem('identity.theme');
    return value === 'light' || value === 'dark' ? value : null;
  });
  const [system, setSystem] = useState<Theme>(themePreference.matches ? 'dark' : 'light');
  const theme = choice ?? system;

  useLayoutEffect(() => {
    const update = (event: MediaQueryListEvent) => setSystem(event.matches ? 'dark' : 'light');
    themePreference.addEventListener('change', update);
    return () => themePreference.removeEventListener('change', update);
  }, []);

  useLayoutEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  function toggle() {
    const next = theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('identity.theme', next);
    setChoice(next);
  }

  return { theme, toggle };
}

export function BrandHeader({ language, onLanguageChange }: { language: Language; onLanguageChange?: () => void }) {
  const { theme, toggle } = useTheme();
  const labels = copy[language];
  const icon = { width: 18, height: 18, 'aria-hidden': true } as const;
  const themeLabel = theme === 'light' ? labels.dark : labels.light;
  return <header>
    <div className={`${container} flex h-14 items-center justify-between gap-2 sm:h-16`}>
      <Link href="/" className="gap-2 font-medium text-foreground no-underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus sm:text-lg">
        <ShieldCheck width={24} height={24} aria-hidden="true" />
        <span>Identity</span>
      </Link>
      <div className="flex shrink-0 items-center gap-1">
        <Button isIconOnly size="sm" variant="ghost" aria-label={themeLabel} onPress={toggle}>
          {theme === 'light' ? <Moon {...icon} /> : <Sun {...icon} />}
        </Button>
        {onLanguageChange && <Button isIconOnly size="sm" variant="ghost" aria-label={labels.language} onPress={onLanguageChange}>
          <Globe {...icon} />
        </Button>}
        <Link className={buttonVariants({ isIconOnly: true, size: 'sm', variant: 'ghost' })} href={repository}
          aria-label={labels.github}>
          <LogoGithub {...icon} />
        </Link>
      </div>
    </div>
  </header>;
}

export function BrandFooter() {
  return <footer className={`${container} flex justify-center py-8`}>
    <Link href="https://niltavi.com/" aria-label="Niltavi">
      <img src={wordmarkLight} width="72" height="26" alt="" className="dark:hidden" />
      <img src={wordmarkDark} width="72" height="26" alt="" className="hidden dark:block" />
    </Link>
  </footer>;
}

export function Website() {
  const [language, setLanguage] = useState<Language>(() => {
    const saved = localStorage.getItem('identity.language');
    return saved === 'en' || saved === 'zh-CN' ? saved : navigator.language.startsWith('zh') ? 'zh-CN' : 'en';
  });
  const labels = copy[language];
  useLayoutEffect(() => { document.documentElement.lang = language; }, [language]);

  function switchLanguage() {
    const next = language === 'en' ? 'zh-CN' : 'en';
    localStorage.setItem('identity.language', next);
    setLanguage(next);
  }

  return <div className="flex min-h-svh flex-col bg-background text-foreground">
    <BrandHeader language={language} onLanguageChange={switchLanguage} />
    <main className={`${container} flex flex-1 items-center py-16 sm:py-24`}>
      <div className="grid max-w-2xl gap-6">
        <h1 className="text-balance text-4xl font-medium tracking-tight sm:text-5xl lg:text-6xl">{labels.heading}</h1>
        <p className="max-w-lg text-lg text-muted">{labels.description}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Link className={buttonVariants({ variant: 'primary' })} href="/login">{labels.signIn}</Link>
          <Link className={buttonVariants({ variant: 'secondary' })} href="/register">{labels.register}</Link>
          <Link href={guide} hrefLang="en">{labels.install}<Link.Icon /></Link>
        </div>
      </div>
    </main>
    <BrandFooter />
  </div>;
}
