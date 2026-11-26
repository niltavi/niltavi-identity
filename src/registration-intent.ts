import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { readBrowserCookie, realmDigest, setBrowserCookie } from './browser-cookie.js';

export const oidcInteractionSeconds = 1_200;
export const validInteractionUid = (uid: string) => /^[A-Za-z0-9_-]{16,128}$/.test(uid);
const cookie = '__Host-niltavi-registration-intent';
const cookieFor = (uid?: string) => uid ? `${cookie}-${uid}` : cookie;

export function intentDigest(request: FastifyRequest, realm?: string, uid?: string) {
  const token = readBrowserCookie(request, cookieFor(uid));
  return token ? realmDigest(token, realm) : undefined;
}

export async function beginRegistrationIntent(pool: Pool, reply: FastifyReply, uid: string, realm?: string, scoped = false) {
  if (!validInteractionUid(uid)) throw new Error('Invalid authorization interaction.');
  const token = randomBytes(32).toString('base64url');
  const key = realmDigest(token, realm);
  await pool.query('DELETE FROM registration_intents WHERE expires_at <= now()');
  await pool.query(
    "INSERT INTO registration_intents (token_digest, interaction_uid, expires_at) VALUES ($1, $2, now() + $3 * interval '1 second')",
    [key, uid, oidcInteractionSeconds]);
  setBrowserCookie(reply, cookieFor(scoped ? uid : undefined), token, oidcInteractionSeconds);
  return key;
}
