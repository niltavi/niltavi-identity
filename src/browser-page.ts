import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

const contentTypes: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.md': 'text/plain; charset=utf-8',
};

export const protocolPageCsp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";
export type ProtocolView = 'login' | 'logout' | 'signed-out' | 'expired';
export type ProtocolOptions = {
  invalid?: boolean; throttled?: boolean; form?: string; registration?: string | undefined; recover?: string | undefined;
  language?: 'en' | 'zh-CN'; appName?: string | undefined; appUrl?: string | undefined;
  signInName?: string | undefined; signInLogoUrl?: string | undefined;
};
export const pageSections = ['home', 'login', 'register', 'workspace', 'recover', 'reset', 'verify-email', 'invite', 'setup', 'admin'] as const;
const attribute = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export async function registerBrowserPage(app: FastifyInstance, issuer: URL) {
  const root = new URL('../web/dist/', import.meta.url);
  let page: string;
  try { page = await readFile(new URL('index.html', root), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const mount = '<div id="root"></div>';
  if (!page.includes(mount)) throw new Error('The browser bundle is missing its application root.');
  for (const [base, language] of [['', 'en'], ['/zh', 'zh-CN']] as const) {
    for (const section of pageSections) {
      const path = base + (section === 'home' ? '/' : '/' + section);
      const html = (await readFile(new URL(section + '.' + language + '.html', root), 'utf8'))
        .replaceAll('__IDENTITY_ORIGIN__', issuer.origin);
      const send = async (_request: unknown, reply: FastifyReply) => reply.header('content-security-policy', `${protocolPageCsp}; form-action 'self'`)
        .type('text/html; charset=utf-8').send(html);
      app.get(path, send);
      // The account center and the instance console keep their open tab in the path.
      if (section === 'workspace' || section === 'admin') app.get(path + '/:tab', send);
      if (section === 'workspace') app.get(path + '/settings/account', send);
    }
  }
  app.get('/zh', async (_request, reply) => reply.redirect('/zh/', 308));
  app.get('/sitemap.xml', async (_request, reply) => reply.type('application/xml; charset=utf-8').send(
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    ['/', '/zh/'].map(path => '<url><loc>' + issuer.origin + path + '</loc></url>').join('') + '</urlset>'));

  const directory = new URL('identity-assets/', root);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const type = contentTypes[extname(entry.name)];
    if (!entry.isFile() || !type || !/^[a-zA-Z0-9._-]+$/.test(entry.name)) continue;
    const asset = new URL(entry.name, directory);
    const cache = /-[A-Za-z0-9_-]{8}\.(?:js|css)$/.test(entry.name) ? 'public, max-age=31536000, immutable' : 'no-cache';
    app.get(`/identity-assets/${entry.name}`, async (_request, reply) => reply.header('cache-control', cache)
      .type(type).send(createReadStream(asset)));
  }

  return (view: ProtocolView, options: ProtocolOptions = {}) => {
    const data = Object.entries({
      protocol: view, invalid: String(Boolean(options.invalid)), throttled: options.throttled ? 'true' : undefined,
      registration: options.registration, recover: options.recover, language: options.language ?? 'en',
      'app-name': options.appName, 'app-url': options.appUrl,
      'sign-in-name': options.signInName, 'sign-in-logo-url': options.signInLogoUrl,
    }).flatMap(([name, value]) => value === undefined ? [] : [` data-${name}="${attribute(value)}"`]).join('');
    return page.replace('<html lang="en">', () => `<html lang="${options.language ?? 'en'}">`)
      .replace(mount, () => `${options.form ? `<div hidden>${options.form}</div>` : ''}<div id="root"${data}></div>`);
  };
}
