import { randomBytes } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import * as oidc from 'openid-client';
import { html, loginCookie, logoutEvent } from './fixtures.js';
import type { LabClient, LabTls } from './fixtures.js';

type Authorization = { verifier: string; state: string; nonce: string; url: URL };
type Session = { sub: string; sid: string; idToken: string; accessToken: string; refreshToken: string };

const flowCookie = '__Host-identity-lab-flow';
const logoutCookie = '__Host-identity-lab-logout';
const cookieOptions = { path: '/', httpOnly: true, secure: true, sameSite: 'lax' } as const;

export async function buildRelyingParty(spec: LabClient, issuer: string, tls: LabTls) {
  const configuration = await oidc.discovery(
    new URL(issuer), spec.id, undefined, oidc.ClientSecretBasic(spec.secret),
  );
  const jwksUri = configuration.serverMetadata().jwks_uri;
  if (!jwksUri) throw new Error('The fixture issuer did not publish a JWKS URI.');
  const jwks = createRemoteJWKSet(new URL(jwksUri));
  const sessions = new Map<string, Session>();
  const pending = new Map<string, Authorization>();
  const heldCallbacks = new Map<string, URL | null>();
  const seenLogout = new Set<string>();
  let logoutCount = 0;
  let availableForLogout = true;
  let callbackSite: string | string[] | undefined;
  const app = Fastify({ https: tls });
  await app.register(cookie);
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    done(null, new URLSearchParams(body.toString()));
  });

  async function authorize(scope = 'openid read', useResource = true): Promise<Authorization> {
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: spec.callback,
      scope,
      ...(useResource ? { resource: spec.resource } : {}),
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return { verifier, state, nonce, url };
  }

  async function exchange(url: URL, flow: Authorization) {
    const resource = flow.url.searchParams.get('resource');
    return oidc.authorizationCodeGrant(configuration, url, {
      pkceCodeVerifier: flow.verifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    }, resource ? { resource } : undefined);
  }

  function introspect(accessToken: string) {
    return oidc.tokenIntrospection(configuration, accessToken, { token_type_hint: 'access_token' });
  }

  function refresh(refreshToken: string) {
    return oidc.refreshTokenGrant(configuration, refreshToken, { resource: spec.resource });
  }

  app.get('/', async (request, reply) => {
    const id = request.cookies[loginCookie];
    const session = id && sessions.get(id);
    reply.header('cache-control', 'no-store').type('text/html');
    return html(spec.id, session ? `<p>Signed in</p>
      <a href="/api/me">Current account</a>
      <form method="post" action="/logout"><button>Sign out of this app</button></form>
      <form method="post" action="/logout-all"><button>Sign out of all apps</button></form>`
      : '<a href="/login">Sign in</a>');
  });

  app.get('/login', async (_request, reply) => {
    const flow = await authorize();
    pending.set(flow.state, flow);
    reply.setCookie(flowCookie, flow.state, { ...cookieOptions, maxAge: 60 });
    return reply.redirect(flow.url.href);
  });

  app.get('/callback', async (request, reply) => {
    const url = new URL(request.url, spec.origin);
    const callbackState = url.searchParams.get('state');
    // An in-process test can reserve a callback without exchanging its code for tokens.
    if (callbackState && heldCallbacks.get(callbackState) === null) {
      heldCallbacks.set(callbackState, url);
      return reply.header('cache-control', 'no-store').send('Code received by the protocol fixture.');
    }
    const state = request.cookies[flowCookie];
    const flow = state && pending.get(state);
    if (!flow) return reply.code(400).send({ error: 'login_flow_unavailable' });
    pending.delete(flow.state);
    reply.clearCookie(flowCookie, cookieOptions);
    let tokens;
    try {
      tokens = await exchange(url, flow);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof oidc.ResponseBodyError ? error.error : 'login_failed',
      });
    }
    const claims = tokens.claims();
    if (!claims?.sub || typeof claims.sid !== 'string' || !tokens.id_token || !tokens.refresh_token) {
      return reply.code(502).send({ error: 'identity_contract_failed' });
    }
    const oldId = request.cookies[loginCookie];
    if (oldId) sessions.delete(oldId);
    const id = randomBytes(32).toString('base64url');
    sessions.set(id, {
      sub: claims.sub, sid: claims.sid, idToken: tokens.id_token,
      accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
    });
    callbackSite = request.headers['sec-fetch-site'];
    reply.setCookie(loginCookie, id, cookieOptions);
    return reply.redirect('/');
  });

  app.get('/api/me', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const id = request.cookies[loginCookie];
    const session = id && sessions.get(id);
    if (!session) return reply.code(401).send({ error: 'login_required' });
    let token;
    try {
      token = await introspect(session.accessToken);
    } catch {
      return reply.code(503).send({ error: 'identity_unavailable' });
    }
    const audience = Array.isArray(token.aud) ? token.aud : [token.aud];
    if (!token.active || token.iss !== issuer || token.sub !== session.sub ||
        token.client_id !== spec.id || !audience.includes(spec.resource) ||
        !token.scope?.split(' ').includes('read') ||
        typeof token.exp !== 'number' || token.exp <= Date.now() / 1000) {
      sessions.delete(id);
      reply.clearCookie(loginCookie, cookieOptions);
      return reply.code(401).send({ error: 'login_required' });
    }
    return { iss: issuer, sub: session.sub };
  });

  app.post('/logout', async (request, reply) => {
    if (request.headers.origin !== spec.origin) return reply.code(403).send();
    const id = request.cookies[loginCookie];
    const session = id && sessions.get(id);
    if (session) {
      sessions.delete(id);
      await oidc.tokenRevocation(configuration, session.refreshToken, { token_type_hint: 'refresh_token' });
    }
    reply.clearCookie(loginCookie, cookieOptions);
    return reply.redirect('/', 303);
  });

  app.post('/logout-all', async (request, reply) => {
    if (request.headers.origin !== spec.origin) return reply.code(403).send();
    const id = request.cookies[loginCookie];
    const session = id && sessions.get(id);
    if (!session) return reply.redirect('/', 303);
    const state = oidc.randomState();
    reply.setCookie(logoutCookie, state, { ...cookieOptions, maxAge: 60 });
    return reply.redirect(oidc.buildEndSessionUrl(configuration, {
      id_token_hint: session.idToken,
      post_logout_redirect_uri: spec.postLogout,
      state,
    }).href, 303);
  });

  app.get<{ Querystring: { state?: string } }>('/signed-out', async (request, reply) => {
    const state = request.cookies[logoutCookie];
    if (!state || state !== request.query.state) return reply.code(400).send();
    const id = request.cookies[loginCookie];
    if (id) sessions.delete(id);
    reply.clearCookie(loginCookie, cookieOptions);
    reply.clearCookie(logoutCookie, cookieOptions);
    return reply.redirect('/');
  });

  app.post<{ Body: URLSearchParams }>('/oidc/backchannel-logout', async (request, reply) => {
    if (!availableForLogout) return reply.code(503).send();
    const token = request.body?.getAll('logout_token');
    if (token?.length !== 1 || !token[0]) return reply.code(400).send();
    try {
      const { payload } = await jwtVerify(token[0], jwks, {
        issuer, audience: spec.id, algorithms: ['RS256'], maxTokenAge: '2 minutes',
        requiredClaims: ['iat', 'jti', 'sid', 'events'],
      });
      if (typeof payload.sid !== 'string' || typeof payload.jti !== 'string' ||
          typeof payload.events !== 'object' || payload.events === null ||
          !Object.hasOwn(payload.events, logoutEvent) || Object.hasOwn(payload, 'nonce')) {
        return reply.code(400).send();
      }
      if (!seenLogout.has(payload.jti)) {
        for (const [id, session] of sessions) {
          if (session.sid === payload.sid) sessions.delete(id);
        }
        seenLogout.add(payload.jti);
        logoutCount += 1;
      }
      return reply.code(200).send();
    } catch {
      return reply.code(400).send();
    }
  });

  return {
    app, spec, authorize, exchange, introspect, refresh,
    session(id: string) { return sessions.get(id); },
    holdCallback(state: string) { heldCallbacks.set(state, null); },
    takeCallback(state: string) {
      const callback = heldCallbacks.get(state);
      heldCallbacks.delete(state);
      return callback;
    },
    get logoutCount() { return logoutCount; },
    get callbackSite() { return callbackSite; },
    setLogoutReceiverAvailable(available: boolean) { availableForLogout = available; },
  };
}
