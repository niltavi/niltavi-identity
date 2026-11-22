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
export type Section = 'home' | 'login' | 'register' | 'workspace';
export type Route = { language: Language; section: Section };
export type Navigate = (route: Route, replace?: boolean) => void;

export const copy = {
  en: {
    title: 'Niltavi Identity',
    heading: 'One account for your apps',
    description: 'Connect your apps with OpenID Connect. Users sign in once and can view or end their sessions in one place.',
    signIn: 'Sign in', register: 'Register by email', install: 'Install with an agent',
    dark: 'Switch to dark theme', light: 'Switch to light theme', language: 'Language', github: 'GitHub repository',
  },
  'zh-CN': {
    title: 'Niltavi Identity · 统一登录',
    heading: '一个账号，登录多个应用',
    description: '通过 OpenID Connect 接入你的应用。用户登录一次即可访问已接入的应用，并集中查看或结束自己的会话。',
    signIn: '登录', register: '邮箱注册', install: '交给 Agent 安装',
    dark: '切换到深色主题', light: '切换到浅色主题', language: '语言', github: 'GitHub 仓库',
  },
};

export function pathFor({ language, section }: Route) {
  const base = language === 'zh-CN' ? '/zh' : '';
  return base + (section === 'home' ? '/' : '/' + section);
}

export function routeFor(path: string): Route {
  const segments = path.split('/').filter(Boolean);
  const language = segments[0] === 'zh' ? 'zh-CN' : 'en';
  const section = segments[language === 'zh-CN' ? 1 : 0];
  return { language, section: section === 'login' || section === 'register' || section === 'workspace' ? section : 'home' };
}

export function followRoute(event: MouseEvent<Element>, route: Route, navigate?: Navigate) {
  if (navigate && !event.defaultPrevented && event.button === 0 &&
    !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    event.preventDefault();
    navigate(route);
  }
}

export function RouteLink({ route, navigate, onClick, ...props }: Omit<ComponentProps<typeof Link>, 'href'> &
  { route: Route; navigate?: Navigate | undefined; onClick?: ComponentProps<typeof Link>['onClick'] }) {
  return <Link {...props} href={pathFor(route)} onClick={event => {
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

export function BrandHeader({ route, navigate, publicPage = false }: { route: Route; navigate?: Navigate; publicPage?: boolean }) {
  const { language, section } = route;
  const { theme, toggle } = useTheme();
  const labels = copy[language];
  const brandRoute = { language, section: section === 'workspace' ? 'workspace' : 'home' } as const;
  const locales = [
    { locale: 'en', label: 'English', href: pathFor({ language: 'en', section }) },
    { locale: 'zh-CN', label: '简体中文', href: pathFor({ language: 'zh-CN', section }) },
  ];
  function navigateHref(href: string) {
    const destination = new URL(href, window.location.href);
    if (destination.origin === window.location.origin && navigate) navigate(routeFor(destination.pathname));
    else window.location.assign(href);
  }
  const header = <ProductHeader
    brand={{ name: 'Identity', href: pathFor(brandRoute), symbol: <ShieldCheck width={40} height={40} />,
      onClick: event => followRoute(event, brandRoute, navigate) }}
    labels={labels} theme={theme} onToggleTheme={toggle} githubHref={repository} locale={language} locales={locales}
    variant={publicPage ? 'site' : 'app'}
    {...(navigate ? { onNavigateLocale: navigateHref } : {})}
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
