import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type Language = 'en' | 'zh-CN';

export const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
export const random = () => randomBytes(32).toString('base64url');

export function preferredLanguage(request: IncomingMessage): Language {
  return String(request.headers['accept-language'] ?? '').trim().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

// Express rewrites url inside a mounted router and keeps the full path in originalUrl.
export function requestPath(request: IncomingMessage) {
  const full = (request as IncomingMessage & { originalUrl?: unknown }).originalUrl;
  return typeof full === 'string' ? full : request.url ?? '/';
}

export function readCookie(request: IncomingMessage, name: string) {
  const value = request.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(name + '='))?.slice(name.length + 1);
  return value && /^[\w-]{43}$/.test(value) ? value : undefined;
}

// Host-only, HTTPS-only and unreadable by page scripts. The __Host- prefix makes the browser enforce the first two.
export function setCookie(response: ServerResponse, name: string, value: string, maxAge: number) {
  const existing = response.getHeader('set-cookie');
  const prior = existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)];
  response.setHeader('set-cookie', [...prior.filter((cookie) => !cookie.startsWith(name + '=')),
    `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`]);
}

// The page to return to after sign-in. Only a path on this application is accepted, so a
// crafted link can never send a signed-in browser to another site.
export function safeReturnPath(value: unknown, origin: string): string {
  if (typeof value !== 'string' || value.length > 2_048 || !value.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  let url: URL;
  try { url = new URL(value, origin); }
  catch { return '/'; }
  // Checked after normalization: "/.//host" resolves to the path "//host".
  const path = url.pathname + url.search + url.hash;
  if (url.origin !== origin || path.startsWith('//') || path.includes('\\') || url.pathname.startsWith('/auth/')) return '/';
  return path;
}

// A caller that expects data gets a status code. A person in a browser gets a page or a redirect.
export function expectsData(request: IncomingMessage) {
  const accept = String(request.headers.accept ?? '');
  return /^bearer /i.test(request.headers.authorization ?? '') || request.headers['sec-fetch-dest'] === 'empty' ||
    (accept.includes('application/json') && !accept.includes('text/html'));
}

const bodyLimit = 16_384;

// Reads a small form or JSON body as string fields. A framework that already parsed the body is respected.
export async function readFields(request: IncomingMessage): Promise<Record<string, string> | undefined> {
  const parsed = (request as IncomingMessage & { body?: unknown }).body;
  let source: unknown = parsed;
  if (parsed === undefined || typeof parsed === 'string' || Buffer.isBuffer(parsed)) {
    let text = typeof parsed === 'string' ? parsed : Buffer.isBuffer(parsed) ? parsed.toString('utf8') : '';
    if (parsed === undefined) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += part.length;
        if (size > bodyLimit) return undefined;
        chunks.push(part);
      }
      text = Buffer.concat(chunks).toString('utf8');
    }
    if (text.length > bodyLimit) return undefined;
    const type = String(request.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase();
    if (type === 'application/json') {
      try { source = text ? JSON.parse(text) : {}; }
      catch { return undefined; }
    } else if (type === 'application/x-www-form-urlencoded' || !text) source = Object.fromEntries(new URLSearchParams(text));
    else return undefined;
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) if (typeof value === 'string') fields[name] = value;
  return fields;
}

export function send(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  response.statusCode = status;
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(body);
}

export function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  send(response, status, JSON.stringify(body), { 'content-type': 'application/json; charset=utf-8', ...headers });
}

export function redirect(response: ServerResponse, location: string, status = 302) {
  send(response, status, '', { location });
}

const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const style = 'body{font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.25rem;color-scheme:light dark}' +
  'h1{font-size:1.375rem;font-weight:600}a{color:inherit}p a{margin-right:1rem}';
const pageCsp = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(style).digest('base64')}'; ` +
  "base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

export type PageLink = { href: string; label: string };

// The few pages the SDK shows on its own: signed out, access refused, sign-in failed, service unavailable.
export function sendPage(response: ServerResponse, status: number, language: Language, title: string, message: string,
  links: PageLink[] = [], headers: Record<string, string> = {}) {
  send(response, status, `<!doctype html><html lang="${language}"><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><style>${style}</style>` +
    `<main><h1>${escape(title)}</h1>${message ? `<p>${escape(message)}</p>` : ''}` +
    (links.length ? `<p>${links.map(({ href, label }) => `<a href="${escape(href)}">${escape(label)}</a>`).join('')}</p>` : '') +
    '</main></html>', { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': pageCsp, ...headers });
}
