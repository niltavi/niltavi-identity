import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { renderToString } from 'react-dom/server';
import { BrowserApp } from './src/main';
import { copy, pathFor, sections } from './src/site';
import type { Language } from './src/site';
import { themeInitialization, themeKey } from './vendor/niltavi-ui/product/theme';

const assets = new URL('./dist/identity-assets/', import.meta.url);
const template = await readFile(new URL('./dist/index.html', import.meta.url), 'utf8');
const origin = '__IDENTITY_ORIGIN__';
const escape = (value: string) => value
  .replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const migrateTheme = 'try { const old = localStorage.getItem("identity.theme"); if ((old === "light" || old === "dark") && ' +
  '!localStorage.getItem(' + JSON.stringify(themeKey) + ')) localStorage.setItem(' + JSON.stringify(themeKey) + ', old); } catch {}';

await Promise.all([
  ...['niltavi-logo-light.svg', 'niltavi-logo-dark.svg'].map(name =>
    copyFile(new URL('./src/brand/' + name, import.meta.url), new URL(name, assets))),
  copyFile(new URL('../docs/en/for-agents.md', import.meta.url), new URL('for-agents.md', assets)),
  copyFile(new URL('../docs/en/authentication.md', import.meta.url), new URL('authentication.md', assets)),
  writeFile(new URL('theme.js', assets), migrateTheme + '\n' + themeInitialization),
]);

for (const language of ['en', 'zh-CN'] as const satisfies readonly Language[]) {
  for (const section of sections) {
    const route = { language, section };
    const path = pathFor(route);
    const labels = copy[language];
    const canonical = '<link rel="canonical" href="' + origin + path + '" />';
    const alternates = ['en', 'zh-CN', 'x-default'].map(alternate => '<link rel="alternate" hreflang="' + alternate +
      '" href="' + origin + pathFor({ section, language: alternate === 'zh-CN' ? 'zh-CN' : 'en' }) + '" />');
    const metadata = [
      '<title>' + escape(labels.title) + '</title>',
      '<meta name="description" content="' + escape(labels.description) + '" />',
      '<meta name="robots" content="' + (section === 'home' ? 'index,follow' : 'noindex') + '" />',
      canonical, ...alternates,
    ];
    const markup = renderToString(<BrowserApp initial={route} />);
    const page = template.replace('<html lang="en">', '<html lang="' + language + '">')
      .replace('<title>Niltavi Identity</title>', metadata.join('\n    '))
      .replace('<div id="root"></div>', () => '<div id="root" data-prerendered>' + markup + '</div>');
    await writeFile(new URL('./dist/' + section + '.' + language + '.html', import.meta.url), page);
  }
}
