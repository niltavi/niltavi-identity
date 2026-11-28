import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { browserCookie, readBrowserCookie, realmDigest, setBrowserCookie } from './browser-cookie.js';
import type { Queryable } from './database.js';

export const sessionCookie = '__Host-niltavi-session';
export const sessionSeconds = 43_200;

export type Viewer = {
  key: string;
  sessionId: string;
  id: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  locale: 'en' | 'zh-CN' | null;
  instanceRole: 'owner' | 'admin' | null;
  secondFactorEnabled: boolean;
  secondFactorVerified: boolean;
  deletionRequested: boolean;
  deletionRequestedAt: Date | null;
  hasPassword: boolean;
  signedInAt: Date;
  expiresAt: Date;
  activeSessions: number;
};

export function requestLanguage(request: FastifyRequest, preference?: Viewer['locale']) {
  const language = preference ?? request.headers['accept-language'];
  return language?.toLowerCase().startsWith('zh') ? 'zh' as const : 'en' as const;
}

export function fields(request: FastifyRequest, ...keys: string[]) {
  const data = request.body;
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== keys.length) return undefined;
  const values = data as Record<string, unknown>;
  const selected = keys.map((key) => values[key]);
  return selected.every((value) => typeof value === 'string') ? selected as string[] : undefined;
}

export function failure(reply: FastifyReply, status: number, error: string) {
  return reply.code(status).send({ error });
}

export function createWebSessions(pool: Pool, issuer: URL, realm?: string) {
  const keyFor = (token: string) => realmDigest(token, realm);
  const cookieKey = (request: FastifyRequest) => {
    const value = readBrowserCookie(request, sessionCookie);
    return value ? keyFor(value) : undefined;
  };

  async function viewer(request: FastifyRequest) {
    const key = cookieKey(request);
    if (!key) return undefined;
    const row = (await pool.query<Omit<Viewer, 'key'>>(
      `SELECT s.id AS "sessionId", a.id, a.email, a.email_verified_at IS NOT NULL AS "emailVerified",
              a.display_name AS name, a.locale, a.instance_role AS "instanceRole",
              a.totp_confirmed_at IS NOT NULL AS "secondFactorEnabled",
              (a.totp_confirmed_at IS NOT NULL AND s.second_factor_at IS NOT NULL) AS "secondFactorVerified",
              a.deletion_requested_at IS NOT NULL AS "deletionRequested", a.deletion_requested_at AS "deletionRequestedAt",
              a.password_hash IS NOT NULL AS "hasPassword",
              s.created_at AS "signedInAt", s.expires_at AS "expiresAt",
              (SELECT count(*)::int FROM web_sessions active WHERE active.account_id = a.id
                AND active.expires_at > now() AND active.account_epoch = a.security_epoch) AS "activeSessions"
       FROM web_sessions s JOIN accounts a ON a.id = s.account_id
       WHERE s.token_digest = $1 AND s.expires_at > now() AND a.enabled AND a.security_epoch = s.account_epoch`, [key],
    )).rows[0];
    return row ? { ...row, key } : undefined;
  }

  // Writes the session row and returns the cookie value. The caller holds the account lock.
  async function issue(db: Queryable, account: string, epoch: number, request: FastifyRequest) {
    const token = randomBytes(32).toString('base64url');
    const previous = cookieKey(request);
    if (previous) await db.query('DELETE FROM web_sessions WHERE token_digest = $1', [previous]);
    await db.query('DELETE FROM web_sessions WHERE account_id = $1 AND expires_at <= now()', [account]);
    await db.query(`INSERT INTO web_sessions (token_digest, id, account_id, account_epoch, expires_at, user_agent)
      VALUES ($1, $2, $3, $4, now() + $5 * interval '1 second', $6)`,
    [keyFor(token), randomUUID(), account, epoch, sessionSeconds, request.headers['user-agent']?.slice(0, 300) ?? null]);
    return token;
  }

  return {
    keyFor, cookieKey, viewer, issue,
    cookie: (token: string) => browserCookie(sessionCookie, token, sessionSeconds),
    grant(reply: FastifyReply, token: string) { setBrowserCookie(reply, sessionCookie, token, sessionSeconds); },
    clear(reply: FastifyReply) { setBrowserCookie(reply, sessionCookie, '', 0); },
    // State-changing browser requests must be same-origin JSON.
    async origin(request: FastifyRequest, reply: FastifyReply) {
      if (request.headers.origin !== issuer.origin) return failure(reply, 403, 'unexpected_origin');
      if (request.headers['content-type']?.split(';', 1)[0] !== 'application/json') return failure(reply, 415, 'json_required');
    },
  };
}

export type WebSessions = ReturnType<typeof createWebSessions>;
