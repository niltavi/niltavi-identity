import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { exportJWK, generateKeyPair } from 'jose';
import Provider, { errors } from 'oidc-provider';
import type { ClientMetadata } from 'oidc-provider';
import { getGlobalDispatcher } from 'undici';
import { accountId, html } from './fixtures.js';
import type { LabClient, LabTls } from './fixtures.js';
import type { LabStore } from './store.js';

export async function buildIdentity(
  issuer: string,
  tls: LabTls,
  store: LabStore,
  clients: readonly LabClient[],
) {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const key = { ...await exportJWK(privateKey), kid: randomUUID(), alg: 'RS256', use: 'sig' as const };
  const byId = new Map<string, LabClient>(clients.map((client) => [client.id, client]));
  const logoutTargets = new Set(clients.map((client) => client.backchannelLogout));
  const metadata = clients.map((client): ClientMetadata => ({
    client_id: client.id,
    client_secret: client.secret,
    token_endpoint_auth_method: 'client_secret_basic',
    redirect_uris: [client.callback],
    post_logout_redirect_uris: [client.postLogout],
    backchannel_logout_uri: client.backchannelLogout,
    backchannel_logout_session_required: true,
    response_types: ['code'],
    grant_types: ['authorization_code', 'refresh_token'],
  }));
  const provider = new Provider(issuer, {
    adapter: store.Adapter,
    clients: metadata,
    jwks: { keys: [key] },
    // The lab can contact only its pre-registered HTTPS receivers on loopback.
    // Production deployments should keep the provider's default egress protection.
    fetch(url, options) {
      if (!logoutTargets.has(String(url))) {
        throw new Error('The outbound URL is not a fixture logout receiver.');
      }
      const request = { ...options, redirect: 'error' as const, dispatcher: getGlobalDispatcher() };
      return globalThis.fetch(url, request);
    },
    cookies: {
      keys: [randomBytes(32).toString('base64url')],
      long: { httpOnly: true, sameSite: 'lax', secure: true },
      short: { httpOnly: true, sameSite: 'lax', secure: true },
    },
    ttl: {
      AuthorizationCode: 60, AccessToken: 300, IdToken: 300, Interaction: 120,
      Session: 43_200, Grant: 43_200, RefreshToken: 43_200,
    },
    pkce: { required: () => true },
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
          ctx.body = html('End the central session', `${form}
            <button type="submit" form="op.logoutForm" name="logout" value="yes">End session</button>`);
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
          if (resource !== byId.get(client.clientId)?.resource) {
            throw new errors.InvalidTarget('The resource is not registered for this client');
          }
          return { scope: 'read', audience: resource, accessTokenFormat: 'opaque', accessTokenTTL: 300 };
        },
      },
    },
    scopes: ['openid'],
    async findAccount(_ctx, id) {
      if (await store.isEnabled(id)) {
        return { accountId: id, claims: () => ({ sub: id }) };
      }
    },
    // Both clients are static first-party fixtures. Grant only their fixed scopes.
    async loadExistingGrant(ctx) {
      const { client, session, result } = ctx.oidc;
      if (!client || !session?.accountId || !byId.has(client.clientId)) {
        return;
      }
      const existingId = result?.consent?.grantId ?? session.grantIdFor(client.clientId);
      const existing = existingId && await provider.Grant.find(existingId);
      if (existing) {
        return existing;
      }
      const grant = new provider.Grant({ clientId: client.clientId, accountId: session.accountId });
      grant.addOIDCScope('openid');
      const resource = byId.get(client.clientId)?.resource;
      if (resource) {
        grant.addResourceScope(resource, 'read');
      }
      await grant.save();
      return grant;
    },
  });
  let interactionCount = 0;
  let successfulLogouts = 0;
  provider.on('backchannel.success', () => { successfulLogouts += 1; });
  provider.on('server_error', (_ctx, error) => {
    console.error('Identity lab provider error:', error.message);
  });

  const app = Fastify({ https: tls });
  app.get('/interaction/:uid', async (request, reply) => {
    await provider.interactionDetails(request.raw, reply.raw);
    const ready = await store.isEnabled(accountId);
    reply.header('cache-control', 'no-store').type('text/html');
    if (!ready) {
      return reply.code(403).send(html('Account disabled', '<p>This fixture account is disabled.</p>'));
    }
    interactionCount += 1;
    return reply.send(html('Fixture sign-in', '<form method="post" enctype="text/plain"><button>Sign in as fixture user</button></form>'));
  });
  app.post<{ Params: { uid: string } }>('/interaction/:uid', async (request, reply) => {
    if (request.headers.origin !== issuer || !await store.isEnabled(accountId)) {
      return reply.code(403).send({ error: 'sign_in_unavailable' });
    }
    const details = await provider.interactionDetails(request.raw, reply.raw);
    if (details.uid !== request.params.uid || details.prompt.name !== 'login') {
      return reply.code(400).send({ error: 'unexpected_interaction' });
    }
    reply.hijack();
    await provider.interactionFinished(request.raw, reply.raw, {
      login: { accountId },
    }, { mergeWithLastSubmission: false });
  });

  // The provider owns parsing and cookies on its routes. Hand it the raw request
  // before Fastify parses form posts such as the token endpoint.
  const callback = provider.callback();
  app.route({
    method: ['GET', 'POST', 'OPTIONS'],
    url: '/*',
    async onRequest(request, reply) {
      reply.hijack();
      await callback(request.raw, reply.raw);
    },
    handler() {
      return undefined;
    },
  });

  return {
    app,
    get interactionCount() { return interactionCount; },
    get successfulLogouts() { return successfulLogouts; },
  };
}
