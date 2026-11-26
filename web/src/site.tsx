import { Link, RouterProvider, buttonVariants } from '@heroui/react';
import { useLayoutEffect, useState } from 'react';
import type { ComponentProps, MouseEvent } from 'react';
import { isPublicSection, pagePath, pageSections, publicSections } from '../../src/browser-routes';
import type { Language, Section } from '../../src/browser-routes';
import { ProductFooter, ProductHeader } from '../vendor/niltavi-ui/product/ProductHeader';
import { applyTheme, preferredTheme, saveTheme, systemDarkQuery } from '../vendor/niltavi-ui/product/theme';
import type { ProductTheme } from '../vendor/niltavi-ui/product/theme';

export const container = 'niltavi-container';
export const repository = 'https://github.com/niltavi/niltavi-identity';
export type { Language } from '../../src/browser-routes';
export type Route = { language: Language; section: Section; tab?: string | undefined; team?: string | undefined; accountManagement?: boolean };
export type Navigate = (route: Route, replace?: boolean) => void;

const chineseDescriptionLead = 'AI 时代的用户身份认证基础设施。';
const chineseDescriptionDetail = '作为服务端？作为登录方式？自己本地部署？一站式配齐。';

export const copy = {
  en: {
    title: 'Niltavi Identity',
    heading: 'One identity, wherever you go',
    description: 'User authentication infrastructure for the AI era. Run it as your authentication server, add it as a sign-in option, or deploy it locally.',
    signIn: 'Sign in', register: 'Create an account',
    navigation: 'Website navigation', home: 'Home', 'self-host': 'Self-host',
    dark: 'Switch to dark theme', light: 'Switch to light theme', language: 'Language', github: 'GitHub repository',
  },
  'zh-CN': {
    title: 'Niltavi Identity · 统一登录',
    heading: '一个身份随处可用',
    description: chineseDescriptionLead + chineseDescriptionDetail,
    signIn: '登录', register: '创建账号',
    navigation: '官网导航', home: '首页', 'self-host': '本地部署',
    dark: '切换到深色主题', light: '切换到浅色主题', language: '语言', github: 'GitHub 仓库',
  },
};

const tabbed = (section: Section) => section === 'workspace' || section === 'admin';

export function pathFor({ language, section, tab, team, accountManagement }: Route) {
  return pagePath(language, section) + (tabbed(section) && tab ? '/' + tab : '') +
    (section === 'workspace' && tab === 'settings' && accountManagement ? '/account' : '') +
    (section === 'workspace' && tab === 'teams' && team ? '?team=' + encodeURIComponent(team) : '');
}

export function routeFor(path: string, search = ''): Route {
  const segments = path.split('/').filter(Boolean);
  const language = segments[0] === 'zh' ? 'zh-CN' : 'en';
  const [name, tab, subpage] = segments.slice(language === 'zh-CN' ? 1 : 0);
  const section = pageSections.find((known) => known === name) ?? 'home';
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

export function IdentityIcon({ size }: { size: number }) {
  return <span aria-hidden="true" className="block bg-current forced-color-adjust-none" style={{
    width: size, height: size, mask: 'url(/identity-assets/identity-logo-icon.svg) center / contain no-repeat',
  }} />;
}

// `onLanguage` is for pages that cannot change address when the language changes, such as a sign-in request in progress.
export function BrandHeader({ route, navigate, onLanguage }:
  { route: Route; navigate?: Navigate; onLanguage?: (language: Language) => void }) {
  const { language, section } = route;
  const publicPage = isPublicSection(section);
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
    brand={{ name: 'Identity', href: pathFor(brandRoute), symbol: <IdentityIcon size={40} />,
      onClick: event => followRoute(event, brandRoute, navigate) }}
    labels={labels} theme={theme} onToggleTheme={toggle} githubHref={repository} locale={language} locales={locales}
    variant={publicPage ? 'site' : 'app'}
    {...(navigate || onLanguage ? { onNavigateLocale: navigateHref } : {})}
    {...(publicPage ? { className: 'identity-site-header', signIn: { href: pathFor({ language, section: 'login' }), label: labels.signIn } } : {})}
  >
    {publicPage && <nav aria-label={labels.navigation} className="identity-site-nav flex items-center gap-1">
      {publicSections.map(page => <RouteLink key={page} route={{ language, section: page }} navigate={navigate}
        aria-current={section === page ? 'page' : false}
        className={buttonVariants({ size: 'sm', variant: section === page ? 'secondary' : 'ghost' })}>{labels[page]}</RouteLink>)}
    </nav>}
  </ProductHeader>;
  return navigate ? <RouterProvider navigate={navigateHref}>{header}</RouterProvider> : header;
}

export function BrandFooter() {
  return <ProductFooter lightLogo="/identity-assets/niltavi-logo-light.svg" darkLogo="/identity-assets/niltavi-logo-dark.svg" />;
}

export function Website({ language, navigate }: { language: Language; navigate: Navigate }) {
  const labels = copy[language];
  return <main className={`${container} grid flex-1 content-center gap-8 py-12 sm:py-16 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] md:items-center lg:gap-16`}>
    <div className="grid max-w-2xl gap-6">
      <h1 className="text-balance text-4xl font-medium tracking-tight sm:text-5xl lg:text-6xl">{labels.heading}</h1>
      <p className="max-w-lg text-pretty text-lg/relaxed text-muted">
        {language === 'zh-CN' ? <>{chineseDescriptionLead}<br />{chineseDescriptionDetail}</> : labels.description}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <RouteLink route={{ language, section: 'register' }} navigate={navigate}
          className={buttonVariants({ variant: 'primary' })}>{labels.register}</RouteLink>
        <RouteLink route={{ language, section: 'self-host' }} navigate={navigate}
          className={buttonVariants({ variant: 'secondary' })}>{labels['self-host']}</RouteLink>
      </div>
    </div>
    <img className="order-first w-36 justify-self-center sm:w-44 md:order-none md:w-full md:max-w-xs"
      src="/identity-assets/identity-logo-textured.png" width={1000} height={1000} alt="" />
  </main>;
}
