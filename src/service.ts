import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import type { Server as HttpsServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { FastifyReply, FastifyServerFactory } from 'fastify';
import Provider, { errors } from 'oidc-provider';
import type { ClientMetadata, Configuration } from 'oidc-provider';
import { Agent } from 'undici';
import type { Pool } from 'pg';
import { registerBrowserAuth } from './browser-auth.js';
import { protocolPageCsp, registerBrowserPage } from './browser-page.js';
import { assertSchema, getLogin, listApplications, loginRateAllowed } from './database.js';
import { normalizeEmail, openClientSecret, passwordHash, verifyPassword } from './credentials.js';
import { createProtocolStore } from './protocol-store.js';
import { httpsUrl, loadKeyRing, loadSecretEncryptionKey, required, secretDirectory } from './settings.js';
import { identityTls, watchTls } from './tls.js';
import type { IdentityTls } from './tls.js';

function page(title: string, markup: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title>
  <main><h1>${title}</h1>${markup}</main></html>`;
}

function loginForm(error = false) {
  return page('Sign in to Niltavi Identity', `${error ? '<p>Credentials were not accepted.</p>' : ''}
    <form method="post"><p><label>Email <input type="email" name="email" required autocomplete="username"></label></p>
    <p><label>Password <input type="password" name="password" required autocomplete="current-password"></label></p>
    <button type="submit">Sign in</button></form>`);
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
  if (profile === 'hosted' && [issuer, ...(gatewayIssuer ? [gatewayIssuer] : [])].some(({ hostname }) =>
    hostname !== 'niltavi.com' && !hostname.endsWith('.niltavi.com'))) {
    throw new Error('The hosted profile requires HTTPS issuers on niltavi.com.');
  }
  const gateway = gatewayIssuer ? await application(pool, gatewayIssuer, tls.options, gatewayIssuer.origin) : undefined;
  await gateway?.ready();
  const routeGateway = gateway && gatewayIssuer ? {
    host: gatewayIssuer.host,
    route: (request: IncomingMessage, response: ServerResponse) => gateway.routing(request, response),
  } : undefined;
  const app = await application(pool, issuer, tls.options, undefined, routeGateway);
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
}) {
  const directory = secretDirectory();
  const [ring, encryptionKey, cookieKey, applications, backupHash] = await Promise.all([
    loadKeyRing(directory),
    loadSecretEncryptionKey(directory),
    readFile(join(directory, 'cookies.key'), 'utf8'),
    listApplications(pool),
    passwordHash('unused password for timing comparison'),
  ]);
  if (Buffer.from(cookieKey.trim(), 'base64url').length < 32) throw new Error('The cookie signing key is too short.');

  let protocolUi: Awaited<ReturnType<typeof registerBrowserPage>>;
  const loginPage = (invalid = false) => protocolUi?.('login', invalid) ?? loginForm(invalid);
  function sendLogin(reply: FastifyReply, status = 200) {
    if (protocolUi) reply.header('content-security-policy', protocolPageCsp);
    return reply.code(status).type('text/html').send(loginPage(status !== 200));
  }

  const store = createProtocolStore(pool, realm);
  const byId = new Map(applications.map((client) => [client.id, client]));
  const clients = applications.map((client): ClientMetadata => ({
    client_id: client.id,
    client_secret: openClientSecret(client.id, client.secret_ciphertext, encryptionKey),
    token_endpoint_auth_method: 'client_secret_basic',
    response_types: ['code'],
    grant_types: ['authorization_code', 'refresh_token'],
    redirect_uris: [client.callback],
    post_logout_redirect_uris: [client.post_logout],
    backchannel_logout_uri: client.backchannel_logout,
    backchannel_logout_session_required: true,
  }));
  const wire: Pick<Configuration, 'fetch'> = {};
  let loopback: Agent | undefined;
  if (process.env.IDENTITY_LOOPBACK_CA_FILE) {
    const targets = new Set(applications
      .map((client) => client.backchannel_logout)
      .filter((url) => new URL(url).hostname.endsWith('.localhost')));
    const agent = new Agent({ connect: {
      ca: await readFile(process.env.IDENTITY_LOOPBACK_CA_FILE),
      lookup(_host, options, done) {
        if (options.all) done(null, [{ address: '127.0.0.1', family: 4 }]);
        else done(null, '127.0.0.1', 4);
      },
    } });
    loopback = agent;
    wire.fetch = (url, options) => {
      if (!targets.has(String(url))) throw new Error('The loopback profile permits only registered logout URLs.');
      const request = { ...options, redirect: 'error' as const, dispatcher: agent };
      return globalThis.fetch(url, request);
    };
  }

  const provider = new Provider(issuer.origin, {
    ...wire,
    adapter: store.Adapter,
    clients,
    jwks: { keys: ring.keys },
    cookies: {
      keys: [cookieKey.trim()],
      long: { httpOnly: true, sameSite: 'lax', secure: true },
      short: { httpOnly: true, sameSite: 'lax', secure: true },
    },
    ttl: {
      AccessToken: 300, AuthorizationCode: 60, IdToken: 300, Interaction: 120,
      Grant: 43_200, RefreshToken: 43_200, Session: 43_200,
    },
    pkce: { required: () => true },
    scopes: ['openid', 'email'],
    claims: { email: ['email', 'email_verified'] },
    expiresWithSession: () => true,
    issueRefreshToken: (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    rotateRefreshToken: true,
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    features: {
      devInteractions: { enabled: false },
      backchannelLogout: { enabled: true },
      rpInitiatedLogout: {
        enabled: true,
        logoutSource(ctx, form) {
          ctx.type = 'html';
          if (protocolUi) ctx.set('content-security-policy', protocolPageCsp);
          ctx.body = protocolUi?.('logout', false, form) ?? page('End the central session', `${form}
            <button type="submit" form="op.logoutForm" name="logout" value="yes">End session</button>`);
        },
        postLogoutSuccessSource(ctx) {
          ctx.type = 'html';
          if (protocolUi) ctx.set('content-security-policy', protocolPageCsp);
          ctx.body = protocolUi?.('signed-out') ?? page('Signed out', '');
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
        getResourceServerInfo(_ctx, resource, client) {
          if (resource !== byId.get(client.clientId)?.resource) throw new errors.InvalidTarget();
          return { scope: 'read', audience: resource, accessTokenFormat: 'opaque', accessTokenTTL: 300 };
        },
      },
    },
    async findAccount(_ctx, id) {
      const account = (await pool.query<{ email: string; email_verified: boolean; security_epoch: number }>(
        'SELECT email, email_verified_at IS NOT NULL AS email_verified, security_epoch FROM accounts WHERE id = $1 AND enabled', [id])).rows[0];
      if (account && store.remember(id, account.security_epoch)) {
        return { accountId: id, claims: () => ({ sub: id, email: account.email, email_verified: account.email_verified }) };
      }
    },
    async loadExistingGrant(ctx) {
      const { client, session, result } = ctx.oidc;
      const entry = client && byId.get(client.clientId);
      if (!session?.accountId || !entry) return;
      const id = result?.consent?.grantId ?? session.grantIdFor(entry.id);
      const existing = id && await provider.Grant.find(id);
      const requestedEmail = ctx.oidc.requestParamScopes.has('email');
      if (existing) {
        if (requestedEmail && !existing.getOIDCScope().split(' ').includes('email')) {
          existing.addOIDCScope('email');
          await existing.save();
        }
        return existing;
      }
      const grant = new provider.Grant({ clientId: entry.id, accountId: session.accountId });
      grant.addOIDCScope(requestedEmail ? 'openid email' : 'openid');
      grant.addResourceScope(entry.resource, 'read');
      await grant.save();
      return grant;
    },
  });

  const serverFactory: FastifyServerFactory<HttpsServer> = (handler) => createServer(tls, (request, response) => {
    if (gateway && request.headers.host === gateway.host) gateway.route(request, response);
    else handler(request, response);
  });
  const app = Fastify<HttpsServer>({ https: tls, bodyLimit: 4096, trustProxy: false,
    ...(gateway ? { serverFactory } : {}), });
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.host !== issuer.host) return reply.code(421).send({ error: 'unexpected_host' });
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', "frame-ancestors 'none'; base-uri 'none'");
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
  await registerBrowserAuth(app, pool, issuer, backupHash, realm);
  protocolUi = await registerBrowserPage(app, issuer);
  app.get<{ Params: { uid: string } }>('/interaction/:uid', async (request, reply) => store.request(async () => {
    const details = await provider.interactionDetails(request.raw, reply.raw).catch(() => undefined);
    if (!details || details.uid !== request.params.uid || details.prompt.name !== 'login') {
      return reply.code(400).send({ error: 'unexpected_interaction' });
    }
    return sendLogin(reply.header('referrer-policy', 'same-origin'));
  }));
  app.post<{ Params: { uid: string }; Body: URLSearchParams }>('/interaction/:uid', async (request, reply) => store.request(async () => {
    // A same-origin form response must preserve Origin for a retry after invalid credentials.
    reply.header('referrer-policy', 'same-origin');
    if (request.headers.origin !== issuer.origin) return reply.code(403).send({ error: 'unexpected_origin' });
    const details = await provider.interactionDetails(request.raw, reply.raw).catch(() => undefined);
    if (!details || details.uid !== request.params.uid || details.prompt.name !== 'login') {
      return reply.code(400).send({ error: 'unexpected_interaction' });
    }
    const body = request.body;
    if (!(body instanceof URLSearchParams) || body.getAll('email').length !== 1 || body.getAll('password').length !== 1) {
      return reply.code(400).send({ error: 'invalid_form' });
    }
    let email: string;
    try { email = normalizeEmail(body.get('email') ?? ''); }
    catch { return sendLogin(reply, 400); }
    if (!await loginRateAllowed(pool, request.ip, email)) {
      return sendLogin(reply.header('retry-after', '60'), 429);
    }
    const account = await getLogin(pool, email);
    const authentic = await verifyPassword(body.get('password') ?? '', account?.password_hash ?? backupHash);
    if (!account?.enabled || !authentic || !store.remember(account.id, account.security_epoch) || !await store.isEnabled(account.id)) {
      return sendLogin(reply, 401);
    }
    reply.hijack();
    try {
      await provider.interactionFinished(request.raw, reply.raw, { login: { accountId: account.id } }, { mergeWithLastSubmission: false });
    } catch {
      if (reply.raw.headersSent) reply.raw.destroy();
      else reply.raw.writeHead(409, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': protocolPageCsp, 'referrer-policy': 'same-origin' }).end(loginPage(true));
    }
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
