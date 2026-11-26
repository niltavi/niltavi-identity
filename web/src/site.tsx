import { Link, RouterProvider, buttonVariants } from '@heroui/react';
import ShieldCheck from '@gravity-ui/icons/ShieldCheck';
import { useLayoutEffect, useState } from 'react';
import type { ComponentProps, MouseEvent } from 'react';
import { ProductFooter, ProductHeader } from '../vendor/niltavi-ui/product/ProductHeader';
import { applyTheme, preferredTheme, saveTheme, systemDarkQuery } from '../vendor/niltavi-ui/product/theme';
import type { ProductTheme } from '../vendor/niltavi-ui/product/theme';

export const container = 'niltavi-container';
const repository = 'https://github.com/niltavi/niltavi-identity';
export const guideUrl = '/identity-assets/for-agents.md';
export type Language = 'en' | 'zh-CN';
export const sections = ['home', 'login', 'register', 'workspace', 'recover', 'reset', 'verify-email', 'invite', 'setup', 'admin'] as const;
export type Section = typeof sections[number];
export type Route = { language: Language; section: Section; tab?: string | undefined; team?: string | undefined; accountManagement?: boolean };
export type Navigate = (route: Route, replace?: boolean) => void;

export const copy = {
  en: {
    title: 'Niltavi Identity',
    heading: 'One account for your apps',
    description: 'Connect your apps with OpenID Connect. Users sign in once and can view or end their sessions in one place.',
    signIn: 'Sign in', register: 'Create an account', install: 'Install with an agent',
    dark: 'Switch to dark theme', light: 'Switch to light theme', language: 'Language', github: 'GitHub repository',
  },
  'zh-CN': {
    title: 'Niltavi Identity · 统一登录',
    heading: '一个账号，登录多个应用',
    description: '通过 OpenID Connect 接入你的应用。用户登录一次即可访问已接入的应用，并集中查看或结束自己的会话。',
    signIn: '登录', register: '创建账号', install: '交给 Agent 安装',
    dark: '切换到深色主题', light: '切换到浅色主题', language: '语言', github: 'GitHub 仓库',
  },
};

const tabbed = (section: Section) => section === 'workspace' || section === 'admin';

export function pathFor({ language, section, tab, team, accountManagement }: Route) {
  const base = language === 'zh-CN' ? '/zh' : '';
  if (section === 'home') return base + '/';
  return base + '/' + section + (tabbed(section) && tab ? '/' + tab : '') +
    (section === 'workspace' && tab === 'settings' && accountManagement ? '/account' : '') +
    (section === 'workspace' && tab === 'teams' && team ? '?team=' + encodeURIComponent(team) : '');
}

export function routeFor(path: string, search = ''): Route {
  const segments = path.split('/').filter(Boolean);
  const language = segments[0] === 'zh' ? 'zh-CN' : 'en';
  const [name, tab, subpage] = segments.slice(language === 'zh-CN' ? 1 : 0);
  const section = sections.find((known) => known === name) ?? 'home';
  const team = new URLSearchParams(search).get('team') ?? undefined;
  return { language, section, ...(tabbed(section) && tab && /^[a-z-]{1,24}$/.test(tab) ? { tab } : {}),
    ...(section === 'workspace' && tab === 'settings' && subpage === 'account' ? { accountManagement: true } : {}),
    ...(section === 'workspace' && tab === 'teams' && team && /^[\w-]{1,64}$/.test(team) ? { team } : {}) };
}

export function followRoute(event: MouseEvent<Element>, route: Route, navigate?: Navigate) {
  if (navigate && !event.defaultPrevented && event.button === 0 &&
    !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    event.preventDefault();
    navigate(route);
  }
}

export function RouteLink({ route, navigate, href, onClick, ...props }: ComponentProps<typeof Link> &
  { route: Route; navigate?: Navigate | undefined }) {
  return <Link {...props} href={href ?? pathFor(route)} onClick={event => {
    onClick?.(event);
    followRoute(event, route, navigate);
  }} />;
}

function useTheme() {
  const [theme, setTheme] = useState<ProductTheme>('light');
  useLayoutEffect(() => {
    const medium = window.matchMedia(systemDarkQuery);
    function update() {
      const current = preferredTheme();
      applyTheme(current);
      setTheme(current);
    }
    update();
    medium.addEventListener('change', update);
    return () => medium.removeEventListener('change', update);
  }, []);

  function toggle() {
    const next = theme === 'light' ? 'dark' : 'light';
    saveTheme(next);
    setTheme(next);
  }
  return { theme, toggle };
}

// `onLanguage` is for pages that cannot change address when the language changes, such as a sign-in request in progress.
export function BrandHeader({ route, navigate, publicPage = false, onLanguage }:
  { route: Route; navigate?: Navigate; publicPage?: boolean; onLanguage?: (language: Language) => void }) {
  const { language, section } = route;
  const { theme, toggle } = useTheme();
  const labels = copy[language];
  const brandRoute = { language, section: section === 'workspace' || section === 'admin' ? 'workspace' : 'home' } as const;
  const locales = ([['en', 'English'], ['zh-CN', '简体中文']] as const).map(([locale, label]) =>
    ({ locale, label, href: onLanguage ? '#' + locale : pathFor({ ...route, language: locale }) }));
  function navigateHref(href: string) {
    if (onLanguage && href.startsWith('#')) return onLanguage(href === '#zh-CN' ? 'zh-CN' : 'en');
    const destination = new URL(href, window.location.href);
    if (destination.origin === window.location.origin && navigate) navigate(routeFor(destination.pathname, destination.search));
    else window.location.assign(href);
  }
  const header = <ProductHeader
    brand={{ name: 'Identity', href: pathFor(brandRoute), symbol: <ShieldCheck width={40} height={40} />,
      onClick: event => followRoute(event, brandRoute, navigate) }}
    labels={labels} theme={theme} onToggleTheme={toggle} githubHref={repository} locale={language} locales={locales}
    variant={publicPage ? 'site' : 'app'}
    {...(navigate || onLanguage ? { onNavigateLocale: navigateHref } : {})}
    {...(publicPage ? { signIn: { href: pathFor({ language, section: 'login' }), label: labels.signIn } } : {})}
  />;
  return navigate ? <RouterProvider navigate={navigateHref}>{header}</RouterProvider> : header;
}

export function BrandFooter() {
  return <ProductFooter lightLogo="/identity-assets/niltavi-logo-light.svg" darkLogo="/identity-assets/niltavi-logo-dark.svg" />;
}

export function Website({ language, navigate }: { language: Language; navigate: Navigate }) {
  const labels = copy[language];
  return <main className={`${container} flex flex-1 items-center py-16 sm:py-24`}>
    <div className="grid max-w-2xl gap-6">
      <h1 className="text-balance text-4xl font-medium tracking-tight sm:text-5xl lg:text-6xl">
        {language === 'en' ? labels.heading : <><span className="whitespace-nowrap">一个账号，</span><wbr /><span className="whitespace-nowrap">登录多个应用</span></>}
      </h1>
      <p className="max-w-lg text-lg text-muted">{labels.description}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Link className={buttonVariants({ variant: 'primary' })} href={guideUrl} hrefLang="en">{labels.install}<Link.Icon /></Link>
        <RouteLink route={{ language, section: 'register' }} navigate={navigate}
          className={buttonVariants({ variant: 'secondary' })}>{labels.register}</RouteLink>
      </div>
    </div>
  </main>;
}
