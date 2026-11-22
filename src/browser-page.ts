import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { FastifyInstance } from 'fastify';

const contentTypes: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.md': 'text/plain; charset=utf-8',
};

export const protocolPageCsp = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";
type ProtocolView = 'login' | 'logout' | 'signed-out';

export async function registerBrowserPage(app: FastifyInstance) {
  const root = new URL('../web/dist/', import.meta.url);
  let page: string;
  try { page = await readFile(new URL('index.html', root), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const mount = '<div id="root"></div>';
  if (!page.includes(mount)) throw new Error('The browser bundle is missing its application root.');
  for (const path of ['/', '/login', '/register']) {
    app.get(path, async (_request, reply) => reply.header('content-security-policy', `${protocolPageCsp}; form-action 'self'`)
      .type('text/html; charset=utf-8').send(page));
  }

  const directory = new URL('identity-assets/', root);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const type = contentTypes[extname(entry.name)];
    if (!entry.isFile() || !type || !/^[a-zA-Z0-9._-]+$/.test(entry.name)) continue;
    const asset = new URL(entry.name, directory);
    app.get(`/identity-assets/${entry.name}`, async (_request, reply) => reply.header('cache-control',
      'public, max-age=31536000, immutable').type(type).send(createReadStream(asset)));
  }

  return (view: ProtocolView, invalid = false, providerForm?: string) => page.replace(mount,
    () => `${providerForm ? `<div hidden>${providerForm}</div>` : ''}<div id="root" data-protocol="${view}" data-invalid="${invalid}"></div>`);
}
