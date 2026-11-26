export const publicSections = ['home', 'self-host'] as const;
export const pageSections = [...publicSections, 'login', 'register', 'workspace', 'recover', 'reset', 'verify-email', 'invite', 'setup', 'admin'] as const;
export type Section = typeof pageSections[number];
export type Language = 'en' | 'zh-CN';

export function isPublicSection(section: Section) {
  return publicSections.some(page => page === section);
}

export function pagePath(language: Language, section: Section) {
  return (language === 'zh-CN' ? '/zh' : '') + (section === 'home' ? '/' : '/' + section);
}
