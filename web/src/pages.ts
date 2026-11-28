import type { Route } from './site';

// The pages of the two signed-in areas. The sidebar, the page heading and the browser title read from here.
type Page = { id: string | undefined; en: string; zh: string };

export const areas = {
  workspace: ['Account center', '账号中心'],
  admin: ['Instance console', '实例管理台'],
} as const;

export const workspacePages = [
  { id: undefined, en: 'Applications', zh: '应用' },
  { id: 'account', en: 'Account', zh: '账号' },
  { id: 'teams', en: 'Teams', zh: '团队' },
  { id: 'tokens', en: 'Agent tokens', zh: 'Agent 令牌' },
] as const satisfies readonly Page[];

export const teamPages = [
  { id: undefined, en: 'Members', zh: '成员' },
  { id: 'applications', en: 'Applications', zh: '应用' },
  { id: 'tokens', en: 'Agent tokens', zh: 'Agent 令牌' },
  { id: 'audit', en: 'Audit log', zh: '审计日志' },
  { id: 'settings', en: 'Settings', zh: '设置' },
] as const satisfies readonly Page[];

export const adminPages = [
  { id: undefined, en: 'Overview', zh: '概览' },
  { id: 'accounts', en: 'Accounts', zh: '账号' },
  { id: 'teams', en: 'Teams', zh: '团队' },
  { id: 'applications', en: 'Applications', zh: '应用' },
  { id: 'mail', en: 'Outgoing mail', zh: '发信' },
  { id: 'audit', en: 'Audit log', zh: '审计日志' },
] as const satisfies readonly Page[];

export function pageOf(route: Pick<Route, 'section' | 'tab' | 'team' | 'page'>): Page | undefined {
  if (route.section === 'admin') return adminPages.find(({ id }) => id === route.tab) ?? adminPages[0];
  if (route.section !== 'workspace') return undefined;
  if (route.tab === 'teams' && route.team) return teamPages.find(({ id }) => id === route.page) ?? teamPages[0];
  return workspacePages.find(({ id }) => id === route.tab) ?? workspacePages[0];
}

// "Members · Account center · Niltavi Identity": the page first, so tabs and history entries can be told apart.
export function pageTitle(route: Route) {
  const page = pageOf(route);
  if (!page || (route.section !== 'workspace' && route.section !== 'admin')) return undefined;
  const index = route.language === 'en' ? 0 : 1;
  return `${route.language === 'en' ? page.en : page.zh} · ${areas[route.section][index]} · Niltavi Identity`;
}
