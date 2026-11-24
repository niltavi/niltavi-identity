import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import {
  applyAccountEnabled, audit, getSetting, lockInstanceAdministration, markEmailVerified, operatorResetLink, registerApplication, rotateApplicationSecret,
  setApplicationEnabled, setInstanceRole, setSetting, standardApplication, transaction,
} from './database.js';
import { PasswordRejected, passwordHash, passwordProblem } from './credentials.js';
import type { Mailer } from './mail.js';
import type { Notifier } from './notify.js';
import { registrationPolicy } from './registration.js';
import { beginMailTest, confirmMailTest, mailFields } from './setup.js';
import { leaveAllTeams } from './teams.js';
import { failure, fields, requestLanguage } from './web-session.js';
import type { Viewer, WebSessions } from './web-session.js';

// The instance console. Any instance administrator can read it. Changing anything also
// needs a second factor confirmed on the current session.
export function registerAdmin(app: FastifyInstance, pool: Pool, issuer: URL, web: WebSessions, mailer: Mailer,
  notifier: Notifier, encryptionKey: Buffer) {
  async function reader(request: FastifyRequest, reply: FastifyReply) {
    const viewer = await web.viewer(request);
    if (!viewer) { await failure(reply, 401, 'sign_in_required'); return undefined; }
    if (!viewer.instanceRole) { await failure(reply, 403, 'administrator_required'); return undefined; }
    return viewer;
  }
  async function writer(request: FastifyRequest, reply: FastifyReply) {
    const viewer = await reader(request, reply);
    if (viewer && !viewer.secondFactorVerified) {
      await failure(reply, 403, viewer.secondFactorEnabled ? 'second_factor_required' : 'second_factor_not_enabled');
      return undefined;
    }
    return viewer;
  }
  const guard = { preHandler: web.origin };
  type Target = { Params: { id: string } };
  // Validation failures carry a stable code. A free-text reason travels beside it for the operator.
  function rejected(reply: FastifyReply, error: unknown) {
    const message = error instanceof Error ? error.message : '';
    return /^[a-z_]+$/.test(message) ? failure(reply, 400, message) : reply.code(400).send({ error: 'request_rejected', message });
  }

  app.get('/admin/api/overview', async (request, reply) => {
    const viewer = await reader(request, reply);
    if (!viewer) return reply;
    const counts = (await pool.query(
      `SELECT (SELECT count(*)::int FROM accounts WHERE deleted_at IS NULL) AS accounts,
              (SELECT count(*)::int FROM orgs WHERE personal_account_id IS NULL) AS teams,
              (SELECT count(*)::int FROM applications) AS applications,
              (SELECT count(*)::int FROM accounts WHERE deletion_requested_at IS NOT NULL AND deleted_at IS NULL) AS "deletionRequests"`)).rows[0];
    return { counts, mail: await mailer.status(), registration: await registrationPolicy(pool),
      canWrite: viewer.secondFactorVerified, secondFactorEnabled: viewer.secondFactorEnabled, role: viewer.instanceRole };
  });

  app.get<{ Querystring: { q?: string } }>('/admin/api/accounts', async (request, reply) => {
    if (!await reader(request, reply)) return reply;
    const search = typeof request.query.q === 'string' ? request.query.q.trim().toLowerCase().slice(0, 120) : '';
    const accounts = (await pool.query(
      `SELECT id, email, display_name AS name, enabled, email_verified_at IS NOT NULL AS "emailVerified", instance_role AS "instanceRole",
              totp_confirmed_at IS NOT NULL AS "secondFactorEnabled", created_at AS "createdAt", deletion_requested_at AS "deletionRequestedAt"
       FROM accounts WHERE deleted_at IS NULL AND ($1 = '' OR position($1 in email) > 0 OR position($1 in lower(coalesce(display_name, ''))) > 0)
       ORDER BY deletion_requested_at IS NULL, created_at DESC LIMIT 200`, [search])).rows;
    return { accounts };
  });

  app.post<Target>('/admin/api/accounts/:id/status', guard, async (request, reply) => {
    const viewer = await writer(request, reply);
    if (!viewer) return reply;
    const [value] = fields(request, 'status') ?? [];
    if (value !== 'enabled' && value !== 'disabled') return failure(reply, 400, 'invalid_status');
    if (request.params.id === viewer.id) return failure(reply, 400, 'own_account');
    const result = await transaction(pool, async (db) => {
      const account = (await db.query<{ id: string; enabled: boolean; security_epoch: number; instance_role: string | null }>(
        'SELECT id, enabled, security_epoch, instance_role FROM accounts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [request.params.id])).rows[0];
      if (!account || (account.instance_role === 'owner' && viewer.instanceRole !== 'owner')) return undefined;
      return applyAccountEnabled(db, account, value === 'enabled', viewer.id);
    });
    if (!result) return failure(reply, 404, 'account_not_found');
    if (result.changed && !result.enabled) notifier.account(result.id);
    return { enabled: result.enabled, changed: result.changed };
  });

  const emailOf = async (id: string) => (await pool.query<{ email: string }>(
    'SELECT email FROM accounts WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0]?.email;

  // The way to recover an account on an instance without outgoing mail.
  app.post<Target>('/admin/api/accounts/:id/reset-link', guard, async (request, reply) => {
    const viewer = await writer(request, reply);
    if (!viewer) return reply;
    const email = await emailOf(request.params.id);
    if (!email || !fields(request)) return failure(reply, 404, 'account_not_found');
    return operatorResetLink(pool, email, issuer.origin, viewer.id);
  });

  app.post<Target>('/admin/api/accounts/:id/verify-email', guard, async (request, reply) => {
    const viewer = await writer(request, reply);
    if (!viewer) return reply;
    const email = await emailOf(request.params.id);
    if (!email || !fields(request)) return failure(reply, 404, 'account_not_found');
    return markEmailVerified(pool, email, viewer.id);
  });

  app.post<Target>('/admin/api/accounts/:id/set-password', guard, async (request, reply) => {
    const viewer = await writer(request, reply);
    if (!viewer) return reply;
    const [password] = fields(request, 'password') ?? [];
    if (!password) return failure(reply, 400, 'invalid_password');
    const problem = passwordProblem(password);
    if (problem) return failure(reply, 400, problem);
    const email = await emailOf(request.params.id);
    if (!email) return failure(reply, 404, 'account_not_found');
    try {
      const hash = await passwordHash(password, email);
      await transaction(pool, async (db) => {
        await db.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [request.params.id, hash]);
        await audit(db, 'account.password_set_by_operator', request.params.id, viewer.id);
      });
      return { changed: true };
    } catch (error) {
      if (error instanceof PasswordRejected) return failure(reply, 400, error.code);
      throw error;
    }
  });

  app.post<Target>('/admin/api/accounts/:id/role', guard, async (request, reply) => {
    const viewer = await writer(request, reply);
    if (!viewer) return reply;
    const [role] = fields(request, 'role') ?? [];
    if (viewer.instanceRole !== 'owner') return failure(reply, 403, 'owner_required');
    if (role !== 'admin' && role !== 'none') return failure(reply, 400, 'invalid_role');
    const email = await emailOf(request.params.id);
    if (!email || request.params.id === viewer.id) return failure(reply, 404, 'account_not_found');
    try { return await setInstanceRole(pool, email, role === 'admin', viewer.id); }
    catch (error) { return rejected(reply, error); }
  });

  // Deletion is final for Identity: the account can no longer sign in and its address is released.
  // Each application decides what happens to the data it holds for that account.
  app.post<Target>('/admin/api/accounts/:id/delete', guard, async (request, reply) => {
    const viewer = await writer(request, reply);
    if (!viewer) return reply;
    if (!fields(request)) return failure(reply, 400, 'unexpected_body');
    if (request.params.id === viewer.id) return failure(reply, 400, 'own_account');
    const outcome = await transaction(pool, async (db) => {
      const account = (await db.query<{ id: string; instance_role: string | null }>(
        'SELECT id, instance_role FROM accounts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [request.params.id])).rows[0];
      if (!account) return undefined;
      if (account.instance_role) return { blocked: ['instance administrator'] };
      const blocked = await leaveAllTeams(db, account.id);
      if (blocked.length) return { blocked };
      await db.query(`UPDATE accounts SET enabled = false, security_epoch = security_epoch + 1, deleted_at = now(),
        email = 'deleted-' || id || '@deleted.invalid', display_name = NULL, password_hash = 'deleted',
        totp_secret = NULL, totp_confirmed_at = NULL, email_verified_at = NULL WHERE id = $1`, [account.id]);
      for (const table of ['oidc_records', 'web_sessions', 'agent_tokens', 'account_links']) {
        await db.query(`DELETE FROM ${table} WHERE account_id = $1`, [account.id]);
      }
      await db.query('DELETE FROM invitations WHERE invited_by = $1 AND accepted_at IS NULL', [account.id]);
      await audit(db, 'account.deleted', account.id, viewer.id);
      return { blocked: [] as string[] };
    });
    if (!outcome) return failure(reply, 404, 'account_not_found');
    if (outcome.blocked.length) return reply.code(409).send({ error: 'sole_team_owner', teams: outcome.blocked });
    notifier.account(request.params.id);
    return { deleted: true };
  });

  app.get('/admin/api/teams', async (request, reply) => {
    if (!await reader(request, reply)) return reply;
    const teams = (await pool.query(
      `SELECT o.id, o.name, o.created_at AS "createdAt", count(m.account_id)::int AS members,
              coalesce(string_agg(a.email, ', ' ORDER BY a.email) FILTER (WHERE m.role = 'owner'), '') AS owners
       FROM orgs o LEFT JOIN memberships m ON m.org_id = o.id LEFT JOIN accounts a ON a.id = m.account_id
       WHERE o.personal_account_id IS NULL GROUP BY o.id ORDER BY o.created_at DESC LIMIT 200`)).rows;
    return { teams };
  });

  app.get('/admin/api/applications', async (request, reply) => {
    if (!await reader(request, reply)) return reply;
    const applications = (await pool.query(
      `SELECT id, name, home_url AS "homeUrl", callback, post_logout AS "postLogout", backchannel_logout AS notifications,
              enabled, created_at AS "createdAt" FROM applications ORDER BY created_at, id`)).rows;
    return { applications };
  });

  // The credentials are in this response only. Identity keeps an encrypted copy it never shows again.
  app.post('/admin/api/applications', guard, async (request, reply) => {
    const viewer = await writer(request, reply);
    if (!viewer) return reply;
    const [id, name, home] = fields(request, 'id', 'name', 'homeUrl') ?? [];
    try { return reply.code(201).send(await registerApplication(pool, encryptionKey, standardApplication(id ?? '', name ?? '', home ?? ''), viewer.id)); }
    catch (error) { return rejected(reply, error); }
  });

  app.post<Target>('/admin/api/applications/:id/rotate', guard, async (request, reply) => {
    const viewer = await writer(request, reply);
    if (!viewer) return reply;
    if (!fields(request)) return failure(reply, 400, 'unexpected_body');
    try { return await rotateApplicationSecret(pool, encryptionKey, request.params.id, viewer.id); }
    catch (error) { return rejected(reply, error); }
  });

  app.post<Target>('/admin/api/applications/:id/status', guard, async (request, reply) => {
    const viewer = await writer(request, reply);
    if (!viewer) return reply;
    const [value] = fields(request, 'status') ?? [];
    if (value !== 'enabled' && value !== 'disabled') return failure(reply, 400, 'invalid_status');
    return setApplicationEnabled(pool, request.params.id, value === 'enabled', viewer.id);
  });

  const mailTarget = (viewer: Viewer) => viewer.email;
  app.post('/admin/api/mail', guard, async (request, reply) => {
    const viewer = await writer(request, reply);
    if (!viewer) return reply;
    const values = fields(request, ...mailFields);
    if (!values) return failure(reply, 400, 'invalid_mail_settings');
    try { await beginMailTest(pool, mailer, values, viewer.id, mailTarget(viewer), requestLanguage(request)); }
    catch (error) { return rejected(reply, error); }
    return reply.code(202).send({ sentTo: mailTarget(viewer) });
  });

  app.post('/admin/api/mail/confirm', guard, async (request, reply) => {
    const viewer = await writer(request, reply);
    if (!viewer) return reply;
    return await confirmMailTest(pool, mailer, fields(request, 'code')?.[0] ?? '', viewer.id) ? { confirmed: true } : failure(reply, 400, 'invalid_code');
  });

  app.post('/admin/api/mail/remove', guard, async (request, reply) => {
    const viewer = await writer(request, reply);
    if (!viewer) return reply;
    if (!fields(request)) return failure(reply, 400, 'unexpected_body');
    await transaction(pool, async (db) => {
      await mailer.remove(db);
      await audit(db, 'instance.mail_removed', 'smtp', viewer.id);
    });
    return mailer.status();
  });

  app.post('/admin/api/registration', guard, async (request, reply) => {
    const viewer = await writer(request, reply);
    if (!viewer) return reply;
    const [policy] = fields(request, 'policy') ?? [];
    if (policy !== 'open' && policy !== 'invite' && policy !== 'closed') return failure(reply, 400, 'invalid_policy');
    await transaction(pool, async (db) => {
      await lockInstanceAdministration(db);
      if (await registrationPolicy(db) === policy) return;
      await setSetting(db, 'registration', policy);
      await audit(db, 'instance.registration_changed', policy, viewer.id);
    });
    return { registration: policy };
  });

  app.get('/admin/api/audit', async (request, reply) => {
    if (!await reader(request, reply)) return reply;
    const events = (await pool.query(
      `SELECT e.event_id AS id, e.action, e.target, e.detail, e.occurred_at AS "occurredAt",
              coalesce(a.email, e.actor) AS actor, coalesce(t.email, p.name, o.name, e.target) AS subject
       FROM audit_events e LEFT JOIN accounts a ON a.id = e.actor LEFT JOIN accounts t ON t.id = e.target
         LEFT JOIN applications p ON p.id = e.target LEFT JOIN orgs o ON o.id = e.target
       ORDER BY e.event_id DESC LIMIT 200`)).rows;
    return { events };
  });
}
