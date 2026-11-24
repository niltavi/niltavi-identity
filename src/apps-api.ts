import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SignJWT, importJWK } from 'jose';
import type { JWK } from 'jose';
import type { Pool } from 'pg';
import { digest } from './browser-cookie.js';
import { openClientSecret } from './credentials.js';
import { audit, rateAllowed } from './database.js';
import type { Application } from './database.js';
import type { ProtocolStore } from './protocol-store.js';
import { orgsFor } from './teams.js';
import { failure, fields } from './web-session.js';

export const serviceTokenSeconds = 300;

// Server-to-server endpoints for registered applications. Each request authenticates with the
// application's credentials over HTTP Basic, the same way it does at the token endpoint.
export async function registerApplicationApi(app: FastifyInstance, pool: Pool, issuer: URL, store: ProtocolStore,
  encryptionKey: Buffer, signing: JWK & { kid: string }) {
  const key = await importJWK(signing, 'RS256');

  async function caller(request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization;
    const decoded = header?.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString('utf8') : '';
    const split = decoded.indexOf(':');
    const id = decodeURIComponent(decoded.slice(0, Math.max(split, 0)));
    const secret = Buffer.from(decodeURIComponent(decoded.slice(split + 1)));
    if (!await rateAllowed(pool, [[`app:source:${request.ip}`, 6_000]])) {
      await failure(reply, 429, 'try_later');
      return undefined;
    }
    const row = split > 0 ? (await pool.query<Application>('SELECT * FROM applications WHERE id = $1 AND enabled', [id])).rows[0] : undefined;
    const expected = Buffer.from(row ? openClientSecret(row.id, row.secret_ciphertext, encryptionKey) : 'unregistered application');
    if (!row || secret.length !== expected.length || !timingSafeEqual(secret, expected)) {
      await failure(reply.header('www-authenticate', 'Basic realm="Niltavi Identity"'), 401, 'invalid_client');
      return undefined;
    }
    return row;
  }

  async function account(sub: string) {
    const row = (await pool.query<{ sub: string; email: string; email_verified: boolean; name: string | null; locale: string | null }>(
      `SELECT id AS sub, email, email_verified_at IS NOT NULL AS email_verified, display_name AS name, locale
       FROM accounts WHERE id = $1 AND enabled`, [sub])).rows[0];
    return row ? { ...row, name: row.name ?? row.email.split('@')[0] } : undefined;
  }

  app.get('/apps/self', async (request, reply) => {
    const client = await caller(request, reply);
    if (!client) return reply;
    return { app_id: client.id, name: client.name, issuer: issuer.origin, home_url: client.home_url, callback: client.callback,
      post_logout: client.post_logout, notifications: client.backchannel_logout };
  });

  // The 60-second check: is this application session still backed by a live central session,
  // and which teams does the account belong to now.
  app.post('/apps/session', async (request, reply) => {
    const client = await caller(request, reply);
    if (!client) return reply;
    const [sub, sid] = fields(request, 'sub', 'sid') ?? [];
    if (!sub || !sid) return failure(reply, 400, 'invalid_request');
    const current = await store.sessionActive(sub, client.id, sid) ? await account(sub) : undefined;
    return current ? { active: true, account: current, orgs: await orgsFor(pool, sub) } : { active: false };
  });

  app.post('/apps/agent-token', async (request, reply) => {
    const client = await caller(request, reply);
    if (!client) return reply;
    const [token] = fields(request, 'token') ?? [];
    if (!token || !/^nvt_[\w-]{43}$/.test(token)) return { active: false };
    // The token is bound to one application and one team, and follows the account's membership.
    const found = (await pool.query<{ id: string; account_id: string; org_id: string; name: string; role: string; personal: boolean }>(
      `UPDATE agent_tokens t SET last_used_at = now() FROM memberships m, orgs o, accounts a
       WHERE t.token_digest = $1 AND t.app_id = $2 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
         AND a.id = t.account_id AND a.enabled AND m.org_id = t.org_id AND m.account_id = t.account_id AND o.id = t.org_id
       RETURNING t.id, t.account_id, t.org_id, o.name, m.role, o.personal_account_id IS NOT NULL AS personal`,
      [digest(token), client.id])).rows[0];
    const owner = found && await account(found.account_id);
    if (!found || !owner) return { active: false };
    return { active: true, token_id: found.id, account: owner,
      org: { org_id: found.org_id, name: found.name, role: found.role, personal: found.personal } };
  });

  // Short-lived proof of the calling application, for another Niltavi service to verify against the JWKS.
  app.post('/apps/service-token', async (request, reply) => {
    const client = await caller(request, reply);
    if (!client) return reply;
    const [audience] = fields(request, 'audience') ?? [];
    const target = audience && (await pool.query('SELECT 1 FROM applications WHERE id = $1 AND enabled', [audience])).rowCount;
    if (!audience || !target) return failure(reply, 400, 'invalid_audience');
    const token = await new SignJWT({ client_id: client.id, scope: 'service' })
      .setProtectedHeader({ alg: 'RS256', kid: signing.kid, typ: 'at+jwt' })
      .setIssuer(issuer.origin).setSubject(client.id).setAudience(audience).setIssuedAt().setJti(randomUUID())
      .setExpirationTime(`${serviceTokenSeconds} seconds`).sign(key);
    await audit(pool, 'service_token.issued', audience, client.id);
    return { access_token: token, token_type: 'Bearer', expires_in: serviceTokenSeconds };
  });
}
