import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { digest } from './browser-cookie.js';
import { audit, rateAllowed, removeApplications, transaction } from './database.js';
import type { Application, Queryable } from './database.js';
import { mailAddress, messages } from './mail.js';
import type { Mailer } from './mail.js';
import type { Notifier } from './notify.js';
import { failure, fields, requestLanguage } from './web-session.js';
import type { Viewer, WebSessions } from './web-session.js';

export type Role = 'owner' | 'admin' | 'member';
export type OrgClaim = { org_id: string; name: string; role: Role; personal: boolean };
const invitationSeconds = 604_800;
const manages = (role: Role | undefined) => role === 'owner' || role === 'admin';

// The teams an application sees for an account, with the personal space first.
// A team's own application sees that team and nothing else about the account.
export async function orgsFor(db: Queryable, account: string, only?: string | null) {
  return (await db.query<OrgClaim>(
    `SELECT o.id AS org_id, o.name, m.role, o.personal_account_id IS NOT NULL AS personal
     FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.account_id = $1 AND ($2::text IS NULL OR o.id = $2)
     ORDER BY o.personal_account_id IS NULL, o.created_at, o.id`, [account, only ?? null])).rows;
}

// Whether an account may enter an application. Instance applications are open to every account.
// A team's application is for its members, and the team may ask for a confirmed second factor.
export type Entry = 'allowed' | 'not_member' | 'second_factor';
export async function entry(db: Queryable, account: string, app: Pick<Application, 'org_id'>, verified: boolean): Promise<Entry> {
  if (!app.org_id) return 'allowed';
  const team = (await db.query<{ required: boolean }>(
    `SELECT o.require_second_factor AS required FROM memberships m JOIN orgs o ON o.id = m.org_id
     WHERE m.org_id = $1 AND m.account_id = $2`, [app.org_id, account])).rows[0];
  if (!team) return 'not_member';
  return team.required && !verified ? 'second_factor' : 'allowed';
}

function teamName(value: string | undefined) {
  const name = (value ?? '').trim();
  return name && [...name].length <= 80 ? name : undefined;
}

export class Refusal extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export type Need = 'member' | 'manage' | 'own';
type Actor = Pick<Viewer, 'id' | 'secondFactorEnabled' | 'secondFactorVerified'>;

// The one place that decides what an account may do in a team. It locks the team row, so
// concurrent membership changes cannot both pass the last-owner check. Managing a team that
// asks for a second factor needs one confirmed on this session.
export async function teamAccess(db: Queryable, org: string, viewer: Actor, need: Need) {
  const team = (await db.query<{ personal: boolean; name: string; requireSecondFactor: boolean }>(
    `SELECT personal_account_id IS NOT NULL AS personal, name, require_second_factor AS "requireSecondFactor"
     FROM orgs WHERE id = $1 FOR UPDATE`, [org])).rows[0];
  const role = (await db.query<{ role: Role }>(
    'SELECT role FROM memberships WHERE org_id = $1 AND account_id = $2', [org, viewer.id])).rows[0]?.role;
  if (!team || !role) throw new Refusal(404, 'team_not_found');
  if (need === 'own' && role !== 'owner') throw new Refusal(403, 'team_owner_required');
  if (need === 'manage' && !manages(role)) throw new Refusal(403, 'team_role_required');
  if (need !== 'member' && team.requireSecondFactor && !viewer.secondFactorVerified) {
    throw new Refusal(403, viewer.secondFactorEnabled ? 'second_factor_required' : 'second_factor_not_enabled');
  }
  return { ...team, role };
}

// Runs a team change in one transaction and turns a refusal into its response.
export async function teamChange<T>(pool: Pool, reply: Parameters<typeof failure>[0], work: Parameters<typeof transaction<T>>[1]) {
  try { return await transaction(pool, work); }
  catch (error) {
    if (error instanceof Refusal) { await failure(reply, error.status, error.code); return undefined; }
    throw error;
  }
}

async function otherOwners(db: Queryable, org: string, account: string) {
  return Number((await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM memberships WHERE org_id = $1 AND role = 'owner' AND account_id <> $2", [org, account])).rows[0]?.count);
}

// Removes an account from every team it does not solely own. Used when an account is deleted.
export async function leaveAllTeams(db: Queryable, account: string) {
  const blocked = (await db.query<{ name: string }>(
    `SELECT o.name FROM memberships m JOIN orgs o ON o.id = m.org_id
     WHERE m.account_id = $1 AND m.role = 'owner' AND o.personal_account_id IS NULL
       AND EXISTS (SELECT 1 FROM memberships other WHERE other.org_id = o.id AND other.account_id <> $1)
       AND NOT EXISTS (SELECT 1 FROM memberships other WHERE other.org_id = o.id AND other.account_id <> $1 AND other.role = 'owner')`,
    [account])).rows;
  if (blocked.length) return blocked.map(({ name }) => name);
  await db.query(`DELETE FROM orgs o WHERE o.personal_account_id IS NULL
    AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id AND m.account_id = $1)
    AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id AND m.account_id <> $1)`, [account]);
  await db.query('DELETE FROM memberships m USING orgs o WHERE o.id = m.org_id AND m.account_id = $1 AND o.personal_account_id IS NULL', [account]);
  return [];
}

export function registerTeams(app: FastifyInstance, pool: Pool, issuer: URL, web: WebSessions, mailer: Mailer, notifier: Notifier) {
  const guard = { preHandler: web.origin };
  type Team = { Params: { org: string } };
  type Member = { Params: { org: string; account: string } };

  const change = <T>(reply: Parameters<typeof failure>[0], work: Parameters<typeof transaction<T>>[1]) => teamChange(pool, reply, work);

  app.get('/account/orgs', async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    const result = await pool.query(
      `SELECT o.id, o.name, m.role, o.personal_account_id IS NOT NULL AS personal, o.require_second_factor AS "requireSecondFactor",
              (SELECT count(*)::int FROM memberships all_members WHERE all_members.org_id = o.id) AS members
       FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.account_id = $1
       ORDER BY o.personal_account_id IS NULL, o.created_at, o.id`, [viewer.id]);
    return { orgs: result.rows };
  });

  app.post('/account/orgs', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    const name = teamName(fields(request, 'name')?.[0]);
    if (!name) return failure(reply, 400, 'invalid_name');
    if (!await rateAllowed(pool, [[`team:create:${viewer.id}`, 20, 3_600]])) return failure(reply, 429, 'try_later');
    const id = randomUUID();
    await transaction(pool, async (db) => {
      await db.query('INSERT INTO orgs (id, name) VALUES ($1, $2)', [id, name]);
      await db.query("INSERT INTO memberships (org_id, account_id, role) VALUES ($1, $2, 'owner')", [id, viewer.id]);
      await audit(db, 'team.created', id, viewer.id, undefined, id);
    });
    notifier.membership(viewer.id);
    return reply.code(201).send({ id, name, role: 'owner', personal: false, members: 1, requireSecondFactor: false });
  });

  app.get<Team>('/account/orgs/:org', async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    const org = (await pool.query<{ id: string; name: string; role: Role; personal: boolean; requireSecondFactor: boolean }>(
      `SELECT o.id, o.name, m.role, o.personal_account_id IS NOT NULL AS personal, o.require_second_factor AS "requireSecondFactor"
       FROM memberships m JOIN orgs o ON o.id = m.org_id
       WHERE m.org_id = $1 AND m.account_id = $2`, [request.params.org, viewer.id])).rows[0];
    if (!org) return failure(reply, 404, 'team_not_found');
    const members = (await pool.query(
      `SELECT a.id, a.email, a.display_name AS name, m.role, a.enabled, m.created_at AS "joinedAt"
       FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.org_id = $1
       ORDER BY array_position(ARRAY['owner', 'admin', 'member'], m.role), a.email`, [org.id])).rows;
    const invitations = manages(org.role) ? (await pool.query(
      `SELECT i.id, i.email, i.role, i.created_at AS "createdAt", i.expires_at AS "expiresAt"
       FROM invitations i WHERE i.org_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
       ORDER BY i.created_at`, [org.id])).rows : [];
    return { org, members, invitations };
  });

  app.post<Team>('/account/orgs/:org/rename', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    const name = teamName(fields(request, 'name')?.[0]);
    if (!name) return failure(reply, 400, 'invalid_name');
    const done = await change(reply, async (db) => {
      const team = await teamAccess(db, request.params.org, viewer, 'manage');
      if (team.personal) throw new Refusal(403, 'team_role_required');
      await db.query('UPDATE orgs SET name = $2 WHERE id = $1', [request.params.org, name]);
      await audit(db, 'team.renamed', request.params.org, viewer.id, undefined, request.params.org);
      return (await db.query<{ account_id: string }>('SELECT account_id FROM memberships WHERE org_id = $1', [request.params.org])).rows;
    });
    if (!done) return reply;
    for (const { account_id: member } of done) notifier.membership(member);
    return { name };
  });

  app.post<Team>('/account/orgs/:org/invitations', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    const [address, role] = fields(request, 'email', 'role') ?? [];
    let email: string;
    try { email = mailAddress(address ?? ''); }
    catch { return failure(reply, 400, 'invalid_email'); }
    if (role !== 'admin' && role !== 'member') return failure(reply, 400, 'invalid_role');
    if (!await rateAllowed(pool, [[`invite:${viewer.id}`, 30, 3_600], [`invite:address:${email}`, 5, 3_600]])) {
      return failure(reply, 429, 'try_later');
    }
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const team = await change(reply, async (db) => {
      const current = await teamAccess(db, request.params.org, viewer, 'member');
      if (current.personal) throw new Refusal(400, 'personal_space');
      await teamAccess(db, request.params.org, viewer, 'manage');
      const member = await db.query(`SELECT 1 FROM memberships m JOIN accounts a ON a.id = m.account_id
        WHERE m.org_id = $1 AND a.email = $2`, [request.params.org, email]);
      if (member.rowCount) throw new Refusal(409, 'already_member');
      // A new invitation to the same address replaces the pending one, so only the latest link works.
      await db.query(`UPDATE invitations SET revoked_at = now() WHERE org_id = $1 AND email = $2
        AND accepted_at IS NULL AND revoked_at IS NULL`, [request.params.org, email]);
      await db.query(`INSERT INTO invitations (id, org_id, email, role, token_digest, invited_by, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, now() + $7 * interval '1 second')`,
      [id, request.params.org, email, role, digest(`invite:${token}`), viewer.id, invitationSeconds]);
      await audit(db, 'team.member_invited', request.params.org, viewer.id, role, request.params.org);
      return current;
    });
    if (!team) return reply;
    const language = requestLanguage(request);
    const link = `${issuer.origin}${language === 'zh' ? '/zh' : ''}/invite#${token}`;
    const delivered = await mailer.general();
    if (delivered) mailer.later(() => mailer.send(email, messages.invitation(link, team.name, viewer.name ?? viewer.email)));
    // The inviter sees the link once, so an instance without outgoing mail can still pass it on.
    return reply.code(201).send({ id, email, role, link, delivered });
  });

  app.post<{ Params: { org: string; invitation: string } }>('/account/orgs/:org/invitations/:invitation/revoke', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    if (!fields(request)) return failure(reply, 400, 'unexpected_body');
    const done = await change(reply, async (db) => {
      await teamAccess(db, request.params.org, viewer, 'manage');
      const revoked = await db.query(`UPDATE invitations SET revoked_at = now() WHERE id = $1 AND org_id = $2
        AND accepted_at IS NULL AND revoked_at IS NULL`, [request.params.invitation, request.params.org]);
      if (revoked.rowCount) await audit(db, 'team.invitation_revoked', request.params.org, viewer.id, undefined, request.params.org);
      return { changed: Boolean(revoked.rowCount) };
    });
    return done ?? reply;
  });

  app.post<Member>('/account/orgs/:org/members/:account/role', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    const [role] = fields(request, 'role') ?? [];
    if (role !== 'owner' && role !== 'admin' && role !== 'member') return failure(reply, 400, 'invalid_role');
    const { org, account } = request.params;
    const done = await change(reply, async (db) => {
      const team = await teamAccess(db, org, viewer, 'member');
      if (team.personal) throw new Refusal(400, 'personal_space');
      await teamAccess(db, org, viewer, 'manage');
      const target = (await db.query<{ role: Role }>('SELECT role FROM memberships WHERE org_id = $1 AND account_id = $2', [org, account])).rows[0];
      if (!target) throw new Refusal(404, 'member_not_found');
      // Nobody hands out more than they hold: only an owner makes, unmakes or changes an owner.
      if (team.role !== 'owner' && (role === 'owner' || target.role === 'owner')) throw new Refusal(403, 'team_owner_required');
      if (target.role === role) return { changed: false };
      if (target.role === 'owner' && !await otherOwners(db, org, account)) throw new Refusal(409, 'last_owner');
      await db.query('UPDATE memberships SET role = $3 WHERE org_id = $1 AND account_id = $2', [org, account, role]);
      await audit(db, 'team.member_role_changed', org, viewer.id, `${account} ${role}`, org);
      return { changed: true };
    });
    if (!done) return reply;
    if (done.changed) notifier.membership(account);
    return done;
  });

  app.post<Member>('/account/orgs/:org/members/:account/remove', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    if (!fields(request)) return failure(reply, 400, 'unexpected_body');
    const { org, account } = request.params;
    const done = await change(reply, async (db) => {
      const team = await teamAccess(db, org, viewer, 'member');
      if (team.personal) throw new Refusal(400, 'personal_space');
      const self = account === viewer.id;
      if (!self) await teamAccess(db, org, viewer, 'manage');
      const target = (await db.query<{ role: Role }>('SELECT role FROM memberships WHERE org_id = $1 AND account_id = $2', [org, account])).rows[0];
      if (!target) throw new Refusal(404, 'member_not_found');
      if (!self && target.role === 'owner' && team.role !== 'owner') throw new Refusal(403, 'team_owner_required');
      // A team always keeps an owner: the last one cannot leave or be removed.
      if (target.role === 'owner' && !await otherOwners(db, org, account)) throw new Refusal(409, 'last_owner');
      await db.query('DELETE FROM memberships WHERE org_id = $1 AND account_id = $2', [org, account]);
      await db.query('UPDATE agent_tokens SET revoked_at = now() WHERE org_id = $1 AND account_id = $2 AND revoked_at IS NULL', [org, account]);
      await audit(db, self ? 'team.member_left' : 'team.member_removed', org, viewer.id, account, org);
      return { removed: true };
    });
    if (!done) return reply;
    notifier.membership(account);
    return done;
  });

  // The owner hands the team to another member and stays on as an administrator.
  app.post<Team>('/account/orgs/:org/transfer', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    const [account] = fields(request, 'account') ?? [];
    const { org } = request.params;
    if (!account || account === viewer.id) return failure(reply, 400, 'invalid_request');
    const done = await change(reply, async (db) => {
      const team = await teamAccess(db, org, viewer, 'own');
      if (team.personal) throw new Refusal(400, 'personal_space');
      const target = await db.query("UPDATE memberships SET role = 'owner' WHERE org_id = $1 AND account_id = $2", [org, account]);
      if (!target.rowCount) throw new Refusal(404, 'member_not_found');
      await db.query("UPDATE memberships SET role = 'admin' WHERE org_id = $1 AND account_id = $2", [org, viewer.id]);
      await audit(db, 'team.ownership_transferred', org, viewer.id, account, org);
      return { transferred: true };
    });
    if (!done) return reply;
    notifier.membership(account);
    notifier.membership(viewer.id);
    return done;
  });

  // Asking members for a second factor ends what they hold in the team's applications,
  // so each of them passes the check on the way back in.
  app.post<Team>('/account/orgs/:org/security', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    const [value] = fields(request, 'requireSecondFactor') ?? [];
    if (value !== 'true' && value !== 'false') return failure(reply, 400, 'invalid_request');
    const required = value === 'true';
    const { org } = request.params;
    const done = await change(reply, async (db) => {
      const team = await teamAccess(db, org, viewer, 'own');
      if (team.personal) throw new Refusal(400, 'personal_space');
      if (required && !viewer.secondFactorVerified) {
        throw new Refusal(403, viewer.secondFactorEnabled ? 'second_factor_required' : 'second_factor_not_enabled');
      }
      const changed = await db.query('UPDATE orgs SET require_second_factor = $2 WHERE id = $1 AND require_second_factor <> $2', [org, required]);
      if (!changed.rowCount) return [];
      if (required) {
        await db.query(`UPDATE oidc_records SET consumed_at = clock_timestamp()
          WHERE (model = 'Grant' OR model LIKE '%:Grant') AND consumed_at IS NULL
            AND payload ->> 'clientId' IN (SELECT id FROM applications WHERE org_id = $1)`, [org]);
      }
      await audit(db, 'team.security_changed', org, viewer.id, required ? 'second factor required' : 'second factor optional', org);
      return (await db.query<{ account_id: string }>('SELECT account_id FROM memberships WHERE org_id = $1', [org])).rows;
    });
    if (!done) return reply;
    for (const { account_id: member } of done) notifier.membership(member);
    return { requireSecondFactor: required };
  });

  // Deleting a team removes its applications, its tokens and every membership. Accounts stay.
  app.post<Team>('/account/orgs/:org/delete', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    const [name] = fields(request, 'name') ?? [];
    const { org } = request.params;
    const done = await change(reply, async (db) => {
      const team = await teamAccess(db, org, viewer, 'own');
      if (team.personal) throw new Refusal(400, 'personal_space');
      if ((name ?? '').trim() !== team.name) throw new Refusal(400, 'name_mismatch');
      const members = (await db.query<{ account_id: string }>('SELECT account_id FROM memberships WHERE org_id = $1', [org])).rows;
      const apps = (await db.query<{ id: string }>('SELECT id FROM applications WHERE org_id = $1', [org])).rows;
      await removeApplications(db, apps.map(({ id }) => id));
      await db.query('DELETE FROM orgs WHERE id = $1', [org]);
      await audit(db, 'team.deleted', org, viewer.id, team.name, org);
      return members;
    });
    if (!done) return reply;
    for (const { account_id: member } of done) notifier.membership(member);
    return { deleted: true };
  });

  app.get<Team>('/account/orgs/:org/audit', async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    const { org } = request.params;
    const allowed = await change(reply, (db) => teamAccess(db, org, viewer, 'manage'));
    if (!allowed) return reply;
    const events = (await pool.query(
      `SELECT e.event_id AS id, e.action, e.occurred_at AS "occurredAt", coalesce(a.email, e.actor) AS actor,
              coalesce(t.email, p.name, o.name, k.name, e.target) AS subject,
              CASE WHEN d.id IS NULL THEN e.detail ELSE replace(e.detail, d.id, d.email) END AS detail
       FROM audit_events e LEFT JOIN accounts a ON a.id = e.actor LEFT JOIN accounts t ON t.id = e.target
         LEFT JOIN applications p ON p.id = e.target LEFT JOIN orgs o ON o.id = e.target LEFT JOIN agent_tokens k ON k.id = e.target
         LEFT JOIN accounts d ON d.id = split_part(e.detail, ' ', 1)
       WHERE e.org_id = $1 ORDER BY e.event_id DESC LIMIT 200`, [org])).rows;
    return { events };
  });

  // Anyone holding the link can see which team and address it is for, and nothing else.
  app.post('/account/invitation', guard, async (request, reply) => {
    const [token] = fields(request, 'token') ?? [];
    if (!token || !/^[\w-]{43}$/.test(token)) return failure(reply, 404, 'invitation_unavailable');
    if (!await rateAllowed(pool, [[`invitation:source:${request.ip}`, 60]])) return failure(reply, 429, 'try_later');
    const invitation = (await pool.query<{ team: string; email: string; role: string; inviter: string; state: string }>(
      `SELECT o.name AS team, i.email, i.role, coalesce(a.display_name, a.email) AS inviter,
              CASE WHEN i.accepted_at IS NOT NULL THEN 'accepted' WHEN i.revoked_at IS NOT NULL THEN 'revoked'
                   WHEN i.expires_at <= now() THEN 'expired' ELSE 'pending' END AS state
       FROM invitations i JOIN orgs o ON o.id = i.org_id JOIN accounts a ON a.id = i.invited_by
       WHERE i.token_digest = $1`, [digest(`invite:${token}`)])).rows[0];
    return invitation ?? failure(reply, 404, 'invitation_unavailable');
  });

  app.post('/account/invitation/accept', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    const [token] = fields(request, 'token') ?? [];
    if (!token || !/^[\w-]{43}$/.test(token)) return failure(reply, 404, 'invitation_unavailable');
    const joined = await change(reply, async (db) => {
      // The address must be verified and must be the invited one. An address alone grants nothing.
      const account = (await db.query<{ email: string; verified: boolean }>(
        'SELECT email, email_verified_at IS NOT NULL AS verified FROM accounts WHERE id = $1 AND enabled FOR SHARE', [viewer.id])).rows[0];
      if (!account) throw new Refusal(401, 'sign_in_required');
      const pending = (await db.query<{ email: string }>(
        `SELECT email FROM invitations WHERE token_digest = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
        [digest(`invite:${token}`)])).rows[0];
      if (!pending) throw new Refusal(404, 'invitation_unavailable');
      if (pending.email !== account.email) throw new Refusal(403, 'invitation_email_mismatch');
      if (!account.verified) throw new Refusal(403, 'email_unverified');
      const accepted = (await db.query<{ org_id: string; role: Role }>(
        `UPDATE invitations SET accepted_at = now() WHERE token_digest = $1 AND email = $2
          AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING org_id, role`,
        [digest(`invite:${token}`), account.email])).rows[0];
      if (!accepted) throw new Refusal(404, 'invitation_unavailable');
      await db.query('SELECT 1 FROM orgs WHERE id = $1 FOR UPDATE', [accepted.org_id]);
      await db.query('INSERT INTO memberships (org_id, account_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [accepted.org_id, viewer.id, accepted.role]);
      await audit(db, 'team.member_joined', accepted.org_id, viewer.id, accepted.role, accepted.org_id);
      return { org: accepted.org_id };
    });
    if (!joined) return reply;
    notifier.membership(viewer.id);
    return joined;
  });
}
