import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { digest } from './browser-cookie.js';
import {
  audit, deleteApplication, rateAllowed, registerApplication, rotateApplicationSecret, setApplicationBranding, setApplicationEnabled,
  standardApplication, teamApplicationPolicy,
} from './database.js';
import { publicHost } from './outbound.js';
import { Refusal, teamAccess, teamChange } from './teams.js';
import type { Need } from './teams.js';
import { failure, fields } from './web-session.js';
import type { Viewer, WebSessions } from './web-session.js';

// What a team's administrators run for the team itself: its own applications, and Agent tokens
// that act as the team instead of as one of its members.
export function registerTeamAdmin(app: FastifyInstance, pool: Pool, web: WebSessions, encryptionKey: Buffer) {
  const guard = { preHandler: web.origin };
  type Team = { Params: { org: string } };
  type Item = { Params: { org: string; id: string } };

  // Resolves the signed-in account and its standing in the team, or answers with the refusal.
  async function enter(request: Parameters<WebSessions['viewer']>[0], reply: FastifyReply, org: string, need: Need,
    work?: (db: PoolClient, viewer: Viewer) => Promise<void>) {
    const viewer = await web.viewer(request);
    if (!viewer) { await failure(reply, 401, 'sign_in_required'); return undefined; }
    const team = await teamChange(pool, reply, async (db) => {
      const current = await teamAccess(db, org, viewer, need);
      if (current.personal) throw new Refusal(400, 'personal_space');
      await work?.(db, viewer);
      return current;
    });
    return team && { viewer, team };
  }

  // Anything that creates or reveals a credential needs a second factor confirmed on this session.
  async function writer(request: Parameters<WebSessions['viewer']>[0], reply: FastifyReply, org: string) {
    const entered = await enter(request, reply, org, 'manage');
    if (entered && !entered.viewer.secondFactorVerified) {
      await failure(reply, 403, entered.viewer.secondFactorEnabled ? 'second_factor_required' : 'second_factor_not_enabled');
      return undefined;
    }
    return entered;
  }

  function rejected(reply: FastifyReply, error: unknown) {
    const message = error instanceof Error ? error.message : '';
    return /^[a-z_]+$/.test(message) ? failure(reply, message === 'application_limit' ? 409 : 400, message)
      : reply.code(400).send({ error: 'request_rejected', message });
  }

  app.get<Team>('/account/orgs/:org/tokens', async (request, reply) => {
    const { org } = request.params;
    if (!await enter(request, reply, org, 'manage')) return reply;
    const tokens = (await pool.query(
      `SELECT t.id, t.name, t.hint, CASE WHEN t.account_id IS NULL THEN 'team' ELSE 'member' END AS kind, t.role,
              t.app_id AS "appId", p.name AS "appName", a.email AS member, i.email AS "issuedBy",
              t.created_at AS "createdAt", t.expires_at AS "expiresAt", t.last_used_at AS "lastUsedAt"
       FROM agent_tokens t JOIN applications p ON p.id = t.app_id
         LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN accounts i ON i.id = t.issued_by
       WHERE t.org_id = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
       ORDER BY t.account_id IS NOT NULL, t.created_at DESC`, [org])).rows;
    return { tokens };
  });

  app.post<Team>('/account/orgs/:org/tokens', guard, async (request, reply) => {
    const { org } = request.params;
    const [label, appId, role, days] = fields(request, 'name', 'app', 'role', 'days') ?? [];
    const name = (label ?? '').trim();
    const lifetime = Number(days);
    // A team token always expires: nobody leaves the team to make it stop working.
    if (!name || [...name].length > 80 || !appId || (role !== 'admin' && role !== 'member') ||
      !Number.isInteger(lifetime) || lifetime < 1 || lifetime > 366) return failure(reply, 400, 'invalid_token_request');
    const caller = await web.viewer(request);
    if (!caller) return failure(reply, 401, 'sign_in_required');
    if (!await rateAllowed(pool, [[`token:create:${caller.id}`, 20, 3_600]])) return failure(reply, 429, 'try_later');
    const token = 'nvt_' + randomBytes(32).toString('base64url');
    const id = randomUUID();
    const entered = await enter(request, reply, org, 'manage', async (db, viewer) => {
      const allowed = await db.query('SELECT 1 FROM applications WHERE id = $1 AND enabled AND (org_id IS NULL OR org_id = $2)', [appId, org]);
      if (!allowed.rowCount) throw new Refusal(400, 'invalid_token_request');
      await db.query(`INSERT INTO agent_tokens (id, token_digest, app_id, org_id, name, hint, role, issued_by, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + $9 * interval '1 day')`,
      [id, digest(token), appId, org, name, token.slice(-4), role, viewer.id, lifetime]);
      await audit(db, 'agent_token.issued', id, viewer.id, `${appId} team ${role}`, org);
    });
    if (!entered) return reply;
    // The token value leaves the server here and nowhere else.
    return reply.code(201).send({ id, token });
  });

  // Covers the team's own tokens and the personal tokens its members issued for this team.
  app.post<Item>('/account/orgs/:org/tokens/:id/revoke', guard, async (request, reply) => {
    const { org, id } = request.params;
    if (!fields(request)) return failure(reply, 400, 'unexpected_body');
    let revoked = false;
    const entered = await enter(request, reply, org, 'manage', async (db, viewer) => {
      const changed = await db.query('UPDATE agent_tokens SET revoked_at = now() WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL', [id, org]);
      revoked = Boolean(changed.rowCount);
      if (revoked) await audit(db, 'agent_token.revoked', id, viewer.id, undefined, org);
    });
    if (!entered) return reply;
    return revoked ? reply.code(204).send() : failure(reply, 404, 'token_not_found');
  });

  app.get<Team>('/account/orgs/:org/applications', async (request, reply) => {
    const { org } = request.params;
    if (!await enter(request, reply, org, 'manage')) return reply;
    const [applications, policy] = await Promise.all([
      pool.query(
        `SELECT id, name, home_url AS "homeUrl", callback, post_logout AS "postLogout", backchannel_logout AS notifications,
                sign_in_name AS "signInName", sign_in_logo_url AS "signInLogoUrl", enabled, created_at AS "createdAt"
         FROM applications WHERE org_id = $1 ORDER BY created_at, id`, [org]),
      teamApplicationPolicy(pool),
    ]);
    return { applications: applications.rows, enabled: policy.enabled, limit: policy.limit };
  });

  // The credentials are in this response only. Identity keeps an encrypted copy it never shows again.
  app.post<Team>('/account/orgs/:org/applications', guard, async (request, reply) => {
    const { org } = request.params;
    const entered = await writer(request, reply, org);
    if (!entered) return reply;
    const [id, name, home] = fields(request, 'id', 'name', 'homeUrl') ?? [];
    try {
      const spec = standardApplication(id ?? '', name ?? '', home ?? '');
      // Identity calls the application's notification URL, so a team may not point it inside the network.
      const policy = await teamApplicationPolicy(pool);
      if (!policy.privateNetwork && !process.env.IDENTITY_LOOPBACK_CA_FILE && !await publicHost(new URL(spec.backchannel).hostname)) {
        return failure(reply, 400, 'private_address');
      }
      return reply.code(201).send(await registerApplication(pool, encryptionKey, spec, entered.viewer.id, org));
    } catch (error) { return rejected(reply, error); }
  });

  app.post<Item>('/account/orgs/:org/applications/:id/rotate', guard, async (request, reply) => {
    const { org, id } = request.params;
    const entered = await writer(request, reply, org);
    if (!entered) return reply;
    if (!fields(request)) return failure(reply, 400, 'unexpected_body');
    try { return await rotateApplicationSecret(pool, encryptionKey, id, entered.viewer.id, org); }
    catch { return failure(reply, 404, 'application_not_found'); }
  });

  app.post<Item>('/account/orgs/:org/applications/:id/branding', guard, async (request, reply) => {
    const { org, id } = request.params;
    const entered = await writer(request, reply, org);
    if (!entered) return reply;
    const [name, logo] = fields(request, 'signInName', 'signInLogoUrl') ?? [];
    if (name === undefined || logo === undefined) return failure(reply, 400, 'unexpected_body');
    try {
      return await setApplicationBranding(pool, id, name, logo, entered.viewer.id, org) ? { updated: true }
        : failure(reply, 404, 'application_not_found');
    } catch (error) { return rejected(reply, error); }
  });

  app.post<Item>('/account/orgs/:org/applications/:id/status', guard, async (request, reply) => {
    const { org, id } = request.params;
    const entered = await writer(request, reply, org);
    if (!entered) return reply;
    const [value] = fields(request, 'status') ?? [];
    if (value !== 'enabled' && value !== 'disabled') return failure(reply, 400, 'invalid_status');
    const known = await pool.query('SELECT 1 FROM applications WHERE id = $1 AND org_id = $2', [id, org]);
    if (!known.rowCount) return failure(reply, 404, 'application_not_found');
    return setApplicationEnabled(pool, id, value === 'enabled', entered.viewer.id, org);
  });

  app.post<Item>('/account/orgs/:org/applications/:id/delete', guard, async (request, reply) => {
    const { org, id } = request.params;
    const entered = await writer(request, reply, org);
    if (!entered) return reply;
    if (!fields(request)) return failure(reply, 400, 'unexpected_body');
    return await deleteApplication(pool, id, entered.viewer.id, org) ? { deleted: true } : failure(reply, 404, 'application_not_found');
  });
}
