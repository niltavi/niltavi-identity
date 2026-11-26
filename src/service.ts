import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import type { Server as HttpsServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest, FastifyServerFactory } from 'fastify';
import Provider, { errors, interactionPolicy } from 'oidc-provider';
import type { AdapterPayload, Configuration } from 'oidc-provider';
import { Agent } from 'undici';
import type { Pool } from 'pg';
import { registerAdmin } from './admin-api.js';
import { registerApplicationApi } from './apps-api.js';
import { registerBrowserAuth, testenvSignupAllowed } from './browser-auth.js';
import { protocolPageCsp, registerBrowserPage } from './browser-page.js';
import type { ProtocolOptions, ProtocolView } from './browser-page.js';
import { assertSchema, audit, getLogin, loginRateAllowed, transaction } from './database.js';
import type { Application } from './database.js';
import { normalizeEmail, openClientSecret, passwordHash, verifyAccountPassword } from './credentials.js';
import { createMailer } from './mail.js';
import { createNotifier } from './notify.js';
import { createProtocolStore } from './protocol-store.js';
import { registerSetup } from './setup.js';
import { orgsFor, registerTeams } from './teams.js';
import { createWebSessions, failure, fields } from './web-session.js';
import { beginRegistrationIntent, intentDigest, oidcInteractionSeconds, validInteractionUid } from './registration-intent.js';
import { registrationPolicy } from './registration.js';
import { httpsUrl, loadKeyRing, loadSecretEncryptionKey, required, secretDirectory } from './settings.js';
import { identityTls, watchTls } from './tls.js';
import type { IdentityTls } from './tls.js';

type Language = 'en' | 'zh-CN';
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function page(title: string, markup: string, language: Language = 'en') {
  return `<!doctype html><html lang="${language}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
  <main><h1>${escape(title)}</h1>${markup}</main></html>`;
}

// Plain pages for a build without the browser bundle. They carry the same facts as the shared UI.
function plainPage(view: ProtocolView, { invalid, form, registration, recover, language = 'en', appName, appUrl, signInName, signInLogoUrl }: ProtocolOptions) {
  const text = (en: string, zh: string) => language === 'en' ? en : zh;
  const app = appName ? escape(appName) : undefined;
  if (view === 'login') {
    return page(text('Sign in', '登录'),
      `${signInLogoUrl ? `<img src="${escape(signInLogoUrl)}" alt="${signInName ? '' : app ?? ''}" width="40" height="40" referrerpolicy="no-referrer">` : ''}
      ${signInName ? `<p>${escape(signInName)}</p>` : ''}
      ${invalid ? `<p>${text('Credentials were not accepted.', '邮箱或密码不正确。')}</p>` : ''}
      <form method="post"><p><label>${text('Email', '邮箱')} <input type="email" name="email" required autocomplete="username"></label></p>
      <p><label>${text('Password', '密码')} <input type="password" name="password" required autocomplete="current-password"></label></p>
      <button type="submit">${text('Sign in', '登录')}</button></form>
      ${registration ? `<a href="${registration}">${text('Create an account', '创建账号')}</a>` : ''}
      ${recover ? `<a href="${recover}">${text('Forgot password', '忘记密码')}</a>` : ''}`, language);
  }
  if (view === 'logout') {
    return page(text('Sign out of all Niltavi apps in this browser', '退出这个浏览器上的所有 Niltavi 应用'), `${form ?? ''}
      <button type="submit" form="op.logoutForm" name="logout" value="yes">${text('Sign out', '退出')}</button>`, language);
  }
  if (view === 'signed-out') return page(text('Signed out', '已退出'), '', language);
  return page(text('This sign-in request has expired', '登录请求已过期'),
    `<p>${text('Start again from the application.', '请回到应用重新发起登录。')}</p>` +
    (app && appUrl ? `<a href="${escape(appUrl)}">${text(`Return to ${app}`, `返回 ${app}`)}</a>` : ''), language);
}

export async function service(pool: Pool) {
  await assertSchema(pool);
  const issuer = httpsUrl(required('IDENTITY_ISSUER'), 'Issuer');
  if (issuer.href !== `${issuer.origin}/`) throw new Error('The issuer must be a single HTTPS origin.');
  const port = Number(required('IDENTITY_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid listener port.');
  const host = process.env.IDENTITY_HOST ?? '127.0.0.1';
  const tls = await identityTls(issuer.hostname);
  const gatewayIssuer = process.env.IDENTITY_GATEWAY_ISSUER
    ? httpsUrl(process.env.IDENTITY_GATEWAY_ISSUER, 'Gateway issuer') : undefined;
  if (gatewayIssuer && (gatewayIssuer.href !== `${gatewayIssuer.origin}/` || gatewayIssuer.host === issuer.host)) {
    throw new Error('The gateway issuer must be a distinct HTTPS origin.');
  }
  const profile = process.env.IDENTITY_DEPLOYMENT_PROFILE ?? 'self-hosted';
  if (!['self-hosted', 'hosted', 'acceptance'].includes(profile)) throw new Error('Unknown Identity deployment profile.');
  const official = ({ hostname }: URL) => hostname === 'niltavi.com' || hostname.endsWith('.niltavi.com');
  const canonical = profile === 'hosted' && gatewayIssuer && official(gatewayIssuer) && isIP(issuer.hostname) ? gatewayIssuer : undefined;
  if (profile === 'hosted' && ((!official(issuer) && !canonical) || (gatewayIssuer && !official(gatewayIssuer)))) {
    throw new Error('The hosted profile requires HTTPS issuers on niltavi.com.');
  }
  if (process.env.IDENTITY_TESTENV_UNVERIFIED_SIGNUP === 'true' &&
    ![issuer, ...(gatewayIssuer ? [gatewayIssuer] : [])].some(testenvSignupAllowed)) {
    throw new Error('Unverified signup is reserved for the Identity testenv origin.');
  }
  const gateway = gatewayIssuer ? await application(pool, gatewayIssuer, tls.options, gatewayIssuer.origin) : undefined;
  await gateway?.ready();
  const routeGateway = gateway && gatewayIssuer ? {
    host: gatewayIssuer.host,
    route: (request: IncomingMessage, response: ServerResponse) => gateway.routing(request, response),
  } : undefined;
  const app = await application(pool, issuer, tls.options, undefined, routeGateway, canonical);
  let stopTls: (() => void) | undefined;
  app.addHook('onClose', async () => {
    stopTls?.();
    await gateway?.close();
  });
  await app.listen({ host, port });
  if ('release' in tls) stopTls = watchTls(app.server, tls, issuer.hostname);
  return app;
}

async function application(pool: Pool, issuer: URL, tls: IdentityTls, realm?: string, gateway?: {
  host: string;
  route: (request: IncomingMessage, response: ServerResponse) => void;
}, canonical?: URL) {
  const directory = secretDirectory();
  const [ring, encryptionKey, cookieKey, backupHash] = await Promise.all([
    loadKeyRing(directory),
    loadSecretEncryptionKey(directory),
    readFile(join(directory, 'cookies.key'), 'utf8'),
    passwordHash(randomBytes(32).toString('base64url')),
  ]);
  if (Buffer.from(cookieKey.trim(), 'base64url').length < 32) throw new Error('The cookie signing key is too short.');
  const signing = ring.keys[0];
  if (!signing) throw new Error('The signing key ring is invalid.');

  // Applications are read from the registry on demand, so registering, disabling or
  // rotating one takes effect within seconds and needs no restart.
  const registry = new Map<string, { at: number; value: Application | undefined }>();
  async function registered(id: string) {
    const cached = registry.get(id);
    if (cached && Date.now() - cached.at < 3_000) return cached.value;
    const value = (await pool.query<Application>('SELECT * FROM applications WHERE id = $1 AND enabled', [id])).rows[0];
    registry.set(id, { at: Date.now(), value });
    return value;
  }
  async function client(id: string): Promise<AdapterPayload | undefined> {
    const entry = await registered(id);
    return entry && {
      client_id: entry.id,
      client_name: entry.name,
      client_secret: openClientSecret(entry.id, entry.secret_ciphertext, encryptionKey),
      token_endpoint_auth_method: 'client_secret_basic',
      response_types: ['code'],
      grant_types: ['authorization_code', 'refresh_token'],
      redirect_uris: [entry.callback],
      post_logout_redirect_uris: [entry.post_logout],
      backchannel_logout_uri: entry.backchannel_logout,
      backchannel_logout_session_required: true,
    };
  }
  const loopbackReceiver = async (url: string) => new URL(url).hostname.endsWith('.localhost') &&
    Boolean((await pool.query('SELECT 1 FROM applications WHERE backchannel_logout = $1 AND enabled', [url])).rowCount);

  let protocolUi: Awaited<ReturnType<typeof registerBrowserPage>>;
  const registrationEnabled = !canonical;
  const render = (view: ProtocolView, options: ProtocolOptions = {}) => protocolUi?.(view, options) ?? plainPage(view, options);
  const preferred = (request: FastifyRequest, requested?: unknown): Language =>
    (typeof requested === 'string' && requested.trim() ? requested : request.headers['accept-language'] ?? '')
      .trim().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
  const localPath = (language: Language, path: string) => (language === 'zh-CN' ? '/zh' : '') + path;

  type Details = { uid: string; params: Record<string, unknown> };
  type AuthDetails = Details & { prompt: { name: string } };
  async function loginOptions(request: FastifyRequest, details: AuthDetails): Promise<ProtocolOptions> {
    const language = preferred(request, details.params.ui_locales);
    const requester = typeof details.params.client_id === 'string' ? await registered(details.params.client_id) : undefined;
    const canRegister = registrationEnabled && validInteractionUid(details.uid) && await registrationPolicy(pool) !== 'closed';
    const interactionPath = '/interaction/' + details.uid;
    return {
      language, appName: requester?.name, appUrl: requester?.home_url,
      interactionPath, loginPath: details.prompt.name === 'create' ? interactionPath + '/login' : interactionPath,
      recover: protocolUi ? interactionPath + '/recover' : localPath(language, '/recover'),
      signInName: requester?.sign_in_name ?? undefined, signInLogoUrl: requester?.sign_in_logo_url ?? undefined,
      registration: canRegister ? interactionPath + '/register' : undefined,
      passwordless: await browserAuth.passwordlessAvailable(),
    };
  }
  async function sendInteraction(request: FastifyRequest, reply: FastifyReply, details: AuthDetails, view: 'login' | 'register' | 'recover', status = 200) {
    const options = await loginOptions(request, details);
    const csp = options.signInLogoUrl
      ? protocolPageCsp.replace("img-src 'self' data:", `img-src 'self' data: ${new URL(options.signInLogoUrl).origin}`)
      : protocolPageCsp;
    reply.header('content-security-policy', csp).header('referrer-policy', 'same-origin');
    return reply.code(status).type('text/html').send(render(view, {
      ...options, invalid: status !== 200 && status !== 429, throttled: status === 429 }));
  }
  // Shown only when the request can no longer be completed: it expired, or it was opened in another browser.
  async function sendExpired(request: FastifyRequest, reply: FastifyReply, uid?: string) {
    const id = uid && validInteractionUid(uid) ? await store.interactionClient(uid) : undefined;
    const requester = id ? await registered(id) : undefined;
    if (protocolUi) reply.header('content-security-policy', protocolPageCsp);
    return reply.code(400).type('text/html').send(render('expired', {
      language: preferred(request), appName: requester?.name, appUrl: requester?.home_url }));
  }

  const store = createProtocolStore(pool, realm, client);
  const web = createWebSessions(pool, issuer, realm);
  const mailer = await createMailer(pool, encryptionKey);
  const wire: Pick<Configuration, 'fetch'> = {};
  let loopback: Agent | undefined;
  let outbound = (url: string, init: RequestInit) => globalThis.fetch(url, init);
  if (process.env.IDENTITY_LOOPBACK_CA_FILE) {
    const agent = new Agent({ connect: {
      ca: await readFile(process.env.IDENTITY_LOOPBACK_CA_FILE),
      lookup(_host, options, done) {
        if (options.all) done(null, [{ address: '127.0.0.1', family: 4 }]);
        else done(null, '127.0.0.1', 4);
      },
    } });
    loopback = agent;
    outbound = async (url, init) => {
      if (!await loopbackReceiver(url)) throw new Error('The loopback profile permits only registered notification URLs.');
      return globalThis.fetch(url, { ...init, redirect: 'error', dispatcher: agent } as RequestInit);
    };
    wire.fetch = (url, options) => outbound(String(url), options as RequestInit);
  }
  const notifier = await createNotifier(pool, issuer, signing, outbound);

  const policy = interactionPolicy.base();
  if (registrationEnabled) policy.add(new interactionPolicy.Prompt({ name: 'create', requestable: true }), 0);
  const identityScopes = ['email', 'profile', 'orgs'];
  const provider = new Provider(issuer.origin, {
    ...wire,
    adapter: store.Adapter,
    clients: [],
    jwks: { keys: ring.keys },
    cookies: {
      keys: [cookieKey.trim()],
      long: { httpOnly: true, sameSite: 'lax', secure: true },
      short: { httpOnly: true, sameSite: 'lax', secure: true },
    },
    ttl: {
      AccessToken: 300, AuthorizationCode: 60, IdToken: 300, Interaction: registrationEnabled ? oidcInteractionSeconds : 120,
      Grant: 43_200, RefreshToken: 43_200, Session: 43_200,
    },
    // Authorization code with PKCE is the only way in. Discovery advertises nothing else.
    responseTypes: ['code'],
    pkce: { required: () => true },
    scopes: ['openid', ...identityScopes],
    claims: { email: ['email', 'email_verified'], profile: ['name', 'locale'], orgs: ['orgs'] },
    conformIdTokenClaims: false,
    expiresWithSession: () => true,
    issueRefreshToken: (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    rotateRefreshToken: true,
    interactions: { policy, url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    ...(registrationEnabled ? { discovery: { prompt_values_supported: ['none', 'login', 'consent', 'create'] } } : {}),
    features: {
      devInteractions: { enabled: false },
      backchannelLogout: { enabled: true },
      rpInitiatedLogout: {
        enabled: true,
        logoutSource(ctx, form) {
          ctx.type = 'html';
          if (protocolUi) ctx.set('content-security-policy', protocolPageCsp);
          ctx.body = render('logout', { form, language: ctx.get('accept-language').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en' });
        },
        postLogoutSuccessSource(ctx) {
          ctx.type = 'html';
          if (protocolUi) ctx.set('content-security-policy', protocolPageCsp);
          ctx.body = render('signed-out', { language: ctx.get('accept-language').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en' });
        },
      },
      introspection: {
        enabled: true,
        allowedPolicy: (_ctx, client, token) => token.clientId === client.clientId,
      },
      revocation: {
        enabled: true,
        allowedPolicy: (_ctx, client, token) => token.clientId === client.clientId,
      },
      resourceIndicators: {
        enabled: true,
        async getResourceServerInfo(_ctx, resource, client) {
          if (resource !== (await registered(client.clientId))?.resource) throw new errors.InvalidTarget();
          return { scope: 'read', audience: resource, accessTokenFormat: 'opaque', accessTokenTTL: 300 };
        },
      },
    },
    async findAccount(_ctx, id) {
      const account = (await pool.query<{ email: string; email_verified: boolean; security_epoch: number; name: string | null; locale: string | null }>(
        `SELECT email, email_verified_at IS NOT NULL AS email_verified, security_epoch, display_name AS name, locale
         FROM accounts WHERE id = $1 AND enabled`, [id])).rows[0];
      if (account && store.remember(id, account.security_epoch)) {
        // An application keys its data on issuer and sub. The address is a contact detail, never an identity.
        return { accountId: id, claims: async () => ({
          sub: id, email: account.email, email_verified: account.email_verified,
          name: account.name ?? account.email.split('@')[0], ...(account.locale ? { locale: account.locale } : {}),
          orgs: await orgsFor(pool, id),
        }) };
      }
    },
    async loadExistingGrant(ctx) {
      const { client, session, result } = ctx.oidc;
      const entry = client && await registered(client.clientId);
      if (!session?.accountId || !entry) return;
      const id = result?.consent?.grantId ?? session.grantIdFor(entry.id);
      const existing = id && await provider.Grant.find(id);
      // Registered applications are first-party, so the identity scopes they ask for are granted without a consent page.
      const requested = identityScopes.filter((scope) => ctx.oidc.requestParamScopes.has(scope));
      if (existing) {
        const granted = existing.getOIDCScope().split(' ');
        const missing = requested.filter((scope) => !granted.includes(scope));
        if (missing.length) {
          existing.addOIDCScope(missing.join(' '));
          await existing.save();
        }
        return existing;
      }
      // A fresh grant must not reactivate an application's previous session ID.
      if (id) session.sidFor(entry.id, randomUUID());
      const grant = new provider.Grant({ clientId: entry.id, accountId: session.accountId });
      grant.addOIDCScope(['openid', ...requested].join(' '));
      grant.addResourceScope(entry.resource, 'read');
      await grant.save();
      return grant;
    },
  });

  // Signing out of every application in this browser also signs the browser out of the account
  // center. Otherwise the next sign-in request would be completed silently from that session.
  provider.on('end_session.success', (ctx) => {
    const key = web.cookieKey({ headers: ctx.req.headers } as FastifyRequest);
    if (!key) return;
    void pool.query('DELETE FROM web_sessions WHERE token_digest = $1', [key]).catch(() => undefined);
    const existing = ctx.res.getHeader('set-cookie');
    const prior = existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)];
    ctx.res.setHeader('set-cookie', [...prior, web.cookie('').replace(/Max-Age=\d+/, 'Max-Age=0')]);
  });

  const https = { ...tls, handshakeTimeout: 10_000 };
  const serverFactory: FastifyServerFactory<HttpsServer> = (handler) => createServer(https, (request, response) => {
    if (gateway && request.headers.host === gateway.host) gateway.route(request, response);
    else handler(request, response);
  });
  const app = Fastify<HttpsServer>({ https, bodyLimit: 4096, trustProxy: false,
    ...(gateway ? { serverFactory } : {}), });
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.host !== issuer.host) return reply.code(421).send({ error: 'unexpected_host' });
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', "frame-ancestors 'none'; base-uri 'none'");
    if (canonical && (request.method === 'GET' || request.method === 'HEAD') &&
      ['/', '/zh', '/zh/', '/register', '/zh/register'].includes(request.url)) {
      return reply.redirect(canonical.origin + request.url, 308);
    }
  });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    done(null, new URLSearchParams(body.toString()));
  });
  app.get('/healthz', async (_request, reply) => {
    try {
      await assertSchema(pool);
      return { ready: true };
    } catch {
      return reply.code(503).send({ ready: false });
    }
  });
  const browserAuth = await registerBrowserAuth(app, { pool, issuer, web, mailer, notifier, store, encryptionKey, backupHash, realm, registrationEnabled });
  registerTeams(app, pool, issuer, web, mailer, notifier);
  registerAdmin(app, pool, issuer, web, mailer, notifier, encryptionKey);
  registerSetup(app, pool, web, mailer, backupHash);
  await registerApplicationApi(app, pool, issuer, store, encryptionKey, signing);
  protocolUi = await registerBrowserPage(app, issuer);

  // Completes the authorization request and sends the browser straight back to the application.
  async function finish(request: FastifyRequest, reply: FastifyReply, details: Details, account: string, result: Record<string, unknown> = {},
    cookie?: string) {
    reply.hijack();
    if (cookie) reply.raw.setHeader('set-cookie', cookie);
    try {
      await provider.interactionFinished(request.raw, reply.raw, { login: { accountId: account }, ...result }, { mergeWithLastSubmission: false });
    } catch {
      if (reply.raw.headersSent) reply.raw.destroy();
      else {
        reply.raw.removeHeader('set-cookie');
        reply.raw.writeHead(409, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': protocolPageCsp, 'referrer-policy': 'same-origin' })
          .end(render('expired', { language: preferred(request, details.params.ui_locales) }));
      }
    }
  }

  async function completedRegistration(request: FastifyRequest, uid: string) {
    const key = intentDigest(request, realm, uid);
    if (!key) return false;
    const completed = await pool.query(
      'SELECT 1 FROM registration_intents WHERE token_digest = $1 AND interaction_uid = $2 AND account_id IS NOT NULL AND expires_at > now()',
      [key, uid]);
    return Boolean(completed.rowCount);
  }

  app.get<{ Params: { uid: string } }>('/interaction/:uid', async (request, reply) => store.request(async () => {
    const details = await provider.interactionDetails(request.raw, reply.raw).catch(() => undefined);
    if (!details || details.uid !== request.params.uid || !validInteractionUid(details.uid)) return sendExpired(request, reply, request.params.uid);
    if (await completedRegistration(request, details.uid)) return reply.redirect('/interaction/' + details.uid + '/registered', 303);
    if (details.prompt.name === 'create') return reply.redirect('/interaction/' + details.uid + '/register', 303);
    if (details.prompt.name !== 'login') return reply.code(400).send({ error: 'unexpected_interaction' });
    // A browser already signed in to Identity continues without typing anything, unless the
    // application asked for a fresh sign-in.
    const viewer = details.prompt.reasons.every((reason) => reason === 'no_session') ? await web.viewer(request) : undefined;
    if (viewer && await store.isEnabled(viewer.id)) return finish(request, reply, details, viewer.id);
    return sendInteraction(request, reply, details, 'login');
  }));
  async function completeBrowserSignIn(request: FastifyRequest, reply: FastifyReply, account: string, token: string, result: Record<string, unknown>) {
    let target: URL;
    try {
      const resume = await provider.interactionResult(request.raw, reply.raw, { login: { accountId: account }, ...result }, { mergeWithLastSubmission: false });
      target = new URL(resume, issuer);
    } catch { return failure(reply, 409, 'interaction_expired'); }
    if (target.origin !== issuer.origin || !target.pathname.startsWith('/auth/')) return failure(reply, 409, 'interaction_expired');
    web.grant(reply, token);
    return { continueTo: target.pathname + target.search };
  }
  app.post<{ Params: { uid: string } }>('/interaction/:uid', async (request, reply) => store.request(async () => {
    // A same-origin form response must preserve Origin for a retry after invalid credentials.
    reply.header('referrer-policy', 'same-origin');
    if (request.headers.origin !== issuer.origin) return failure(reply, 403, 'unexpected_origin');
    const body = request.body;
    const native = body instanceof URLSearchParams;
    if (!native && request.headers['content-type']?.split(';', 1)[0] !== 'application/json') return failure(reply, 415, 'json_required');
    const details = await provider.interactionDetails(request.raw, reply.raw).catch(() => undefined);
    if (!details || details.uid !== request.params.uid || !['login', 'create'].includes(details.prompt.name)) {
      return native ? sendExpired(request, reply, request.params.uid) : failure(reply, 409, 'interaction_expired');
    }
    const promptResult = details.prompt.name === 'create' ? { create: {} } : {};
    if (!native && fields(request, 'email')) return browserAuth.requestLoginCode(request, reply, details.uid);
    if (!native && fields(request, 'code')) {
      const result = await browserAuth.verifyLoginCode(request, reply, details.uid);
      if (!result) return reply;
      if (!store.remember(result.id, result.epoch) || !await store.isEnabled(result.id)) return failure(reply, 400, 'invalid_code');
      return completeBrowserSignIn(request, reply, result.id, result.token, promptResult);
    }
    const submitted = native
      ? body.getAll('email').length === 1 && body.getAll('password').length === 1 ? [body.get('email')!, body.get('password')!] : undefined
      : fields(request, 'email', 'password');
    if (!submitted) return failure(reply, 400, 'invalid_form');
    const rejected = (status: number, error: string) => native ? sendInteraction(request, reply, details, 'login', status) : failure(reply, status, error);
    let email: string;
    try { email = normalizeEmail(submitted[0] ?? ''); }
    catch { return rejected(400, 'invalid_email'); }
    if (!await loginRateAllowed(pool, request.ip, email)) {
      reply.header('retry-after', '60');
      return rejected(429, 'try_later');
    }
    const account = await getLogin(pool, email);
    const authentic = await verifyAccountPassword(submitted[1] ?? '', account?.password_hash, backupHash);
    if (!account?.enabled || !authentic || !store.remember(account.id, account.security_epoch) || !await store.isEnabled(account.id)) {
      await audit(pool, 'account.sign_in_failed', account?.id ?? 'unknown', account?.id);
      return rejected(401, 'invalid_credentials');
    }
    // The same sign-in also opens the account center in this browser.
    const token = await transaction(pool, async (db) => {
      const live = await db.query('SELECT 1 FROM accounts WHERE id = $1 AND enabled AND security_epoch = $2 FOR UPDATE',
        [account.id, account.security_epoch]);
      if (!live.rowCount) return undefined;
      await audit(db, 'account.signed_in', account.id, account.id, typeof details.params.client_id === 'string' ? details.params.client_id : undefined);
      return web.issue(db, account.id, account.security_epoch, request);
    });
    if (!token) return rejected(401, 'invalid_credentials');
    return native ? finish(request, reply, details, account.id, promptResult, web.cookie(token))
      : completeBrowserSignIn(request, reply, account.id, token, promptResult);
  }));
  type InteractionRequest = FastifyRequest<{ Params: { uid: string } }>;
  async function activeInteraction(request: InteractionRequest, reply: FastifyReply) {
    if (!validInteractionUid(request.params.uid)) return undefined;
    const details = await provider.interactionDetails(request.raw, reply.raw).catch(() => undefined);
    return details?.uid === request.params.uid && ['login', 'create'].includes(details.prompt.name) ? details : undefined;
  }
  app.get<{ Params: { uid: string } }>('/interaction/:uid/login', async (request, reply) => store.request(async () => {
    const details = await activeInteraction(request, reply);
    if (!details) return sendExpired(request, reply, request.params.uid);
    if (await completedRegistration(request, details.uid)) return reply.redirect('/interaction/' + details.uid + '/registered', 303);
    return sendInteraction(request, reply, details, 'login');
  }));
  app.get<{ Params: { uid: string } }>('/interaction/:uid/recover', async (request, reply) => store.request(async () => {
    const details = await activeInteraction(request, reply);
    if (!details) return sendExpired(request, reply, request.params.uid);
    return protocolUi ? sendInteraction(request, reply, details, 'recover')
      : reply.redirect(localPath(preferred(request, details.params.ui_locales), '/recover'), 303);
  }));
  app.get<{ Params: { uid: string } }>('/interaction/:uid/register', async (request, reply) => store.request(async () => {
    const details = registrationEnabled ? await activeInteraction(request, reply) : undefined;
    if (!details) return sendExpired(request, reply, request.params.uid);
    if (await completedRegistration(request, details.uid)) return reply.redirect('/interaction/' + details.uid + '/registered', 303);
    if (protocolUi) return sendInteraction(request, reply, details, 'register');
    await beginRegistrationIntent(pool, reply, details.uid, realm);
    return reply.redirect(localPath(preferred(request, details.params.ui_locales), '/register'), 303);
  }));
  app.get<{ Params: { uid: string } }>('/interaction/:uid/register/enrollment', async (request, reply) => store.request(async () => {
    const details = registrationEnabled ? await activeInteraction(request, reply) : undefined;
    return details ? browserAuth.pendingEnrollment(request, reply, details.uid) : failure(reply, 409, 'interaction_expired');
  }));
  app.post<{ Params: { uid: string } }>('/interaction/:uid/register', { preHandler: web.origin }, async (request, reply) => store.request(async () => {
    const details = registrationEnabled ? await activeInteraction(request, reply) : undefined;
    if (!details) return failure(reply, 409, 'interaction_expired');
    if (fields(request, 'email', 'code')) return browserAuth.verifyEnrollment(request, reply, details.uid);
    if (fields(request)) return browserAuth.resendEnrollment(request, reply, details.uid);
    return browserAuth.registerAccount(request, reply, details.uid);
  }));
  // The registration page sends the browser here once the account exists. The intent row is
  // deleted as it is read, so the link completes one authorization request exactly once.
  app.get<{ Params: { uid: string } }>('/interaction/:uid/registered', async (request, reply) => store.request(async () => {
    const details = registrationEnabled ? await activeInteraction(request, reply) : undefined;
    if (!details) return sendExpired(request, reply, request.params.uid);
    const intent = intentDigest(request, realm, details.uid) ?? intentDigest(request, realm);
    if (!intent) return sendExpired(request, reply, request.params.uid);
    const account = (await pool.query<{ id: string; security_epoch: number }>(
      `DELETE FROM registration_intents r USING accounts a
        WHERE r.token_digest = $1 AND r.interaction_uid = $2 AND r.expires_at > now() AND r.account_id = a.id
          AND a.enabled AND a.security_epoch = r.account_epoch
        RETURNING a.id, a.security_epoch`, [intent, details.uid])).rows[0];
    if (!account || !store.remember(account.id, account.security_epoch) || !await store.isEnabled(account.id)) {
      return sendExpired(request, reply, request.params.uid);
    }
    return finish(request, reply, details, account.id, details.prompt.name === 'create' ? { create: {} } : {});
  }));
  const callback = provider.callback();
  app.route({
    method: ['GET', 'POST', 'OPTIONS'],
    url: '/*',
    async onRequest(request, reply) {
      reply.hijack();
      await store.request(() => callback(request.raw, reply.raw));
    },
    handler: () => undefined,
  });
  app.addHook('onClose', async () => { await loopback?.close(); });
  return app;
}
