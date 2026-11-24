// The smallest realistic application that signs in with Niltavi Identity.
//
// Required: NILTAVI_IDENTITY_ISSUER, NILTAVI_APP_ID, NILTAVI_APP_SECRET.
// Optional: PORT (3000), APP_HOST (the public host name, for the start-up line), APP_NOUN ("task" or "contract"),
//           APP_TLS_CERT_FILE and APP_TLS_KEY_FILE (serve HTTPS directly; leave unset behind a TLS proxy),
//           APP_PEER_ID and APP_PEER_URL (another Niltavi application that /api/peer calls with a service token).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
// In your own project: import { createIdentity } from '@niltavi/identity-sdk';
import { createIdentity } from '../../sdk/dist/index.js';

const seconds = (name) => process.env[name] ? Number(process.env[name]) : undefined;
const identity = await createIdentity({
  // Only the acceptance tests shorten these. Leave them unset to get 60 seconds and 5 minutes.
  ...(seconds('APP_TEST_CHECK_SECONDS') ? { checkIntervalSeconds: seconds('APP_TEST_CHECK_SECONDS') } : {}),
  ...(seconds('APP_TEST_GRACE_SECONDS') ? { outageGraceSeconds: seconds('APP_TEST_GRACE_SECONDS') } : {}),
});

const noun = process.env.APP_NOUN === 'contract' ? 'contract' : 'task';
const sample = `/${noun}s/${noun === 'contract' ? 7 : 42}`;
const itemPath = new RegExp(`^/${noun}s/(\\d{1,9})$`);
const peer = process.env.APP_PEER_ID && process.env.APP_PEER_URL
  ? { id: process.env.APP_PEER_ID, url: new URL('/api/service/whoami', process.env.APP_PEER_URL).href } : undefined;

const requireLogin = identity.requireLogin();
const requireAdmin = identity.requireRole('admin');
const requireApiLogin = identity.requireLogin({ api: true });
const requireService = identity.requireService();

const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const style = `body{font:16px/1.6 system-ui,sans-serif;margin:0;color-scheme:light dark}
header,main{max-width:44rem;margin:0 auto;padding:1rem 1.25rem}
header a{font-size:1.25rem;font-weight:500;color:inherit;text-decoration:none}
h1{font-size:1.5rem;font-weight:600;margin:.5rem 0 1rem}h2{font-size:1rem;font-weight:600;margin:2rem 0 .5rem}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1.25rem;margin:0}dt{opacity:.7}dd{margin:0;overflow-wrap:anywhere}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.375rem 1rem .375rem 0}th{font-weight:400;opacity:.7}
form{display:inline;margin:0}button{font:inherit;padding:.25rem .75rem;cursor:pointer}
ul{padding:0;list-style:none}li{margin:.5rem 0}li small{display:block;opacity:.7}`;
const csp = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(style).digest('base64')}'; ` +
  `form-action 'self' ${identity.issuer}; base-uri 'none'; frame-ancestors 'none'`;

function language(request) {
  return String(request.headers['accept-language'] ?? '').trim().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

function page(request, response, status, title, body) {
  const lang = language(request);
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': csp,
    'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' });
  response.end(`<!doctype html><html lang="${lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title === identity.app.name ? title : `${title} · ${identity.app.name}`)}</title><style>${style}</style>
<header><a href="/">${escape(identity.app.name)}</a></header><main><h1>${escape(title)}</h1>${body}</main></html>`);
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function home(request, response) {
  const zh = language(request) === 'zh-CN';
  const user = await identity.authenticate(request, response);
  const item = zh ? (noun === 'contract' ? '合同' : '任务') : noun;
  page(request, response, 200, identity.app.name, `
<p>${zh ? `这是一个使用 Niltavi Identity 登录的示例应用。` : 'A sample application that signs in with Niltavi Identity.'}</p>
<p><a href="${sample}">${zh ? `打开${item} ${sample.split('/')[2]}` : `Open ${item} ${sample.split('/')[2]}`}</a></p>
<p>${user ? escape(zh ? `当前登录：${user.name}` : `Signed in as ${user.name}`)
    : `<a href="${escape(identity.loginUrl('/'))}">${zh ? '登录' : 'Sign in'}</a>`}</p>`);
}

function item(request, response, user, id) {
  const zh = language(request) === 'zh-CN';
  const here = `/${noun}s/${id}`;
  const roles = zh ? { owner: '所有者', admin: '管理员', member: '成员' } : { owner: 'Owner', admin: 'Admin', member: 'Member' };
  const teamName = (team) => team.personal ? (zh ? '个人空间' : 'Personal space') : team.name;
  const teams = user.teams.map((team) => `<tr><td>${escape(teamName(team))}</td><td>${roles[team.role]}</td><td>${
    team.id === user.team?.id ? (zh ? '当前团队' : 'Current team')
      : `<form method="post" action="/auth/team"><input type="hidden" name="org_id" value="${escape(team.id)}">` +
        `<input type="hidden" name="return_to" value="${here}"><button>${zh ? '切换' : 'Switch'}</button></form>`}</td></tr>`).join('');
  const signOut = (scope, label) => `<form method="post" action="/auth/logout"><input type="hidden" name="scope" value="${scope}">` +
    `<button>${escape(label)}</button></form>`;
  const title = zh ? `${noun === 'contract' ? '合同' : '任务'} ${id}` : `${noun === 'contract' ? 'Contract' : 'Task'} ${id}`;
  page(request, response, 200, title, `
<h2>${zh ? '账号' : 'Account'}</h2>
<dl><dt>${zh ? '名称' : 'Name'}</dt><dd>${escape(user.name)}</dd>
<dt>${zh ? '邮箱' : 'Email'}</dt><dd>${escape(user.email)} (${user.emailVerified ? (zh ? '已验证' : 'verified') : (zh ? '未验证' : 'not verified')})</dd>
<dt>${zh ? '账号标识' : 'Account ID'}</dt><dd>${escape(user.sub)}</dd></dl>
<h2>${zh ? '团队' : 'Teams'}</h2>
<table><tr><th>${zh ? '团队' : 'Team'}</th><th>${zh ? '角色' : 'Role'}</th><th></th></tr>${teams}</table>
<p><a href="/settings">${zh ? '当前团队的设置' : 'Settings for the current team'}</a></p>
<h2>${zh ? '退出登录' : 'Sign out'}</h2>
<ul><li>${signOut('app', zh ? `只退出 ${identity.app.name}` : `Sign out of ${identity.app.name} only`)}
<small>${zh ? '其他 Niltavi 应用保持登录。' : 'Other Niltavi apps stay signed in.'}</small></li>
<li>${signOut('browser', zh ? '退出这个浏览器上的所有 Niltavi 应用' : 'Sign out of all Niltavi apps in this browser')}</li>
<li><a href="${escape(identity.allDevicesUrl)}">${zh ? '退出所有设备' : 'Sign out on all devices'}</a>
<small>${zh ? '在 Niltavi Identity 的账号中心确认。' : 'You confirm this in your Niltavi Identity account.'}</small></li></ul>`);
}

function settings(request, response, user) {
  const zh = language(request) === 'zh-CN';
  const team = user.team.personal ? (zh ? '个人空间' : 'Personal space') : user.team.name;
  page(request, response, 200, zh ? '设置' : 'Settings', `
<p>${escape(zh ? `当前团队：${team}。只有该团队的管理员和所有者可以打开此页面。` : `Current team: ${team}. Only its admins and owners can open this page.`)}</p>
<p><a href="${sample}">${zh ? '返回' : 'Back'}</a></p>`);
}

async function route(request, response) {
  // Sign-in, the callback, sign-out, team switching and notifications from Identity.
  if (await identity.handle(request, response)) return;
  const { pathname } = new URL(request.url, identity.app.origin);
  if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'method_not_allowed' });

  if (pathname === '/') return home(request, response);
  const id = itemPath.exec(pathname)?.[1];
  if (id) {
    const user = await requireLogin(request, response);
    return user && item(request, response, user, id);
  }
  if (pathname === '/settings') {
    const user = await requireAdmin(request, response);
    return user && settings(request, response, user);
  }
  // The same answer for a person's browser session and for an Agent access token.
  if (pathname === '/api/me') {
    const user = await requireApiLogin(request, response);
    return user && json(response, 200, user);
  }
  // Called by other Niltavi applications, which prove themselves with a service token.
  if (pathname === '/api/service/whoami') {
    const caller = await requireService(request, response);
    return caller && json(response, 200, { app: identity.app.id, caller: caller.appId });
  }
  // Calls another application on this application's own behalf.
  if (pathname === '/api/peer' && peer) {
    if (!await requireApiLogin(request, response)) return;
    const answer = await fetch(peer.url, { headers: { authorization: `Bearer ${await identity.serviceToken(peer.id)}` },
      signal: AbortSignal.timeout(5_000) });
    return json(response, answer.ok ? 200 : 502, { status: answer.status, peer: await answer.json().catch(() => null) });
  }
  page(request, response, 404, language(request) === 'zh-CN' ? '页面不存在' : 'Page not found', '');
}

function listener(request, response) {
  route(request, response).catch(() => {
    if (response.headersSent) response.destroy();
    else json(response, 500, { error: 'server_error' });
  });
}

const tls = process.env.APP_TLS_CERT_FILE && process.env.APP_TLS_KEY_FILE
  ? { cert: readFileSync(process.env.APP_TLS_CERT_FILE), key: readFileSync(process.env.APP_TLS_KEY_FILE) } : undefined;
const server = tls ? createHttpsServer(tls, listener) : createHttpServer(listener);
const port = Number(process.env.PORT ?? 3000);
server.listen(port, process.env.APP_BIND ?? '127.0.0.1', () => {
  const host = process.env.APP_HOST ?? new URL(identity.app.origin).hostname;
  console.log(`${identity.app.name}: ${tls ? 'https' : 'http'}://${host}:${port}${sample}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    identity.close();
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
