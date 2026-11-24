import { randomUUID } from 'node:crypto';
import { SignJWT, importJWK } from 'jose';
import type { JWK } from 'jose';
import type { Pool } from 'pg';
import type { Application } from './database.js';

export const logoutEvent = 'http://schemas.openid.net/event/backchannel-logout';
export const membershipEvent = 'https://niltavi.com/events/membership-changed';
type Outbound = (url: string, init: RequestInit) => Promise<Response>;

// Tells registered applications that an account's access changed. Delivery is best effort:
// each application also checks its sessions with Identity every 60 seconds.
export async function createNotifier(pool: Pool, issuer: URL, signing: JWK & { kid: string }, outbound: Outbound) {
  const key = await importJWK(signing, 'RS256');

  async function post(app: Pick<Application, 'id' | 'backchannel_logout'>, event: string, sub: string, sid?: string) {
    const token = await new SignJWT({ events: { [event]: {} }, ...(sid ? { sid } : {}) })
      .setProtectedHeader({ alg: 'RS256', kid: signing.kid, typ: 'logout+jwt' })
      .setIssuer(issuer.origin).setAudience(app.id).setSubject(sub).setIssuedAt().setJti(randomUUID())
      .setExpirationTime('2 minutes').sign(key);
    for (const wait of [0, 2_000, 10_000]) {
      if (wait) await new Promise((done) => setTimeout(done, wait).unref());
      try {
        const response = await outbound(app.backchannel_logout, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ logout_token: token }).toString(),
        });
        if (response.ok) return;
      } catch { /* The application's own 60-second check covers an unreachable receiver. */ }
    }
  }

  async function apps(ids?: string[]) {
    return (await pool.query<Pick<Application, 'id' | 'backchannel_logout'>>(
      'SELECT id, backchannel_logout FROM applications WHERE enabled AND ($1::text[] IS NULL OR id = ANY($1))', [ids ?? null])).rows;
  }

  return {
    // Every session of the account ended: sign-out everywhere, disabled or deleted account.
    account(sub: string) {
      void apps().then((list) => Promise.all(list.map((app) => post(app, logoutEvent, sub)))).catch(() => undefined);
    },
    // One central session ended. Only the applications it had opened are told.
    session(sub: string, targets: Array<{ id: string; sid: string }>) {
      void apps(targets.map(({ id }) => id)).then((list) => Promise.all(list.map((app) =>
        post(app, logoutEvent, sub, targets.find(({ id }) => id === app.id)?.sid)))).catch(() => undefined);
    },
    // Team membership or role changed. Applications refresh the account's teams.
    membership(sub: string) {
      void apps().then((list) => Promise.all(list.map((app) => post(app, membershipEvent, sub)))).catch(() => undefined);
    },
  };
}

export type Notifier = Awaited<ReturnType<typeof createNotifier>>;
