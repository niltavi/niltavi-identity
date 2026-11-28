import type { Pool, PoolClient } from 'pg';
import { audit, transaction } from './database.js';
import type { Queryable } from './database.js';
import type { Notifier } from './notify.js';
import { leaveAllTeams } from './teams.js';

// A requested deletion waits this long, and the account can withdraw it at any point before.
export const deletionGraceSeconds = 604_800;

// What stops an account from being deleted: holding the instance, or being the only owner of a shared team.
export async function deletionBlockers(db: Queryable, id: string) {
  const account = (await db.query<{ instance_role: string | null }>(
    'SELECT instance_role FROM accounts WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
  if (!account) return undefined;
  if (account.instance_role) return { reason: 'instance_administrator' as const, teams: [] as string[] };
  const teams = (await db.query<{ name: string }>(
    `SELECT o.name FROM memberships m JOIN orgs o ON o.id = m.org_id
     WHERE m.account_id = $1 AND m.role = 'owner' AND o.personal_account_id IS NULL
       AND EXISTS (SELECT 1 FROM memberships other WHERE other.org_id = o.id AND other.account_id <> $1)
       AND NOT EXISTS (SELECT 1 FROM memberships other WHERE other.org_id = o.id AND other.account_id <> $1 AND other.role = 'owner')`,
    [id])).rows.map(({ name }) => name);
  return teams.length ? { reason: 'sole_team_owner' as const, teams } : null;
}

// Deletion is final for Identity: the account can no longer sign in and its address is released.
// Each application decides what happens to the data it holds for that account.
export async function deleteAccount(db: PoolClient, id: string, actor?: string) {
  const account = (await db.query<{ id: string }>('SELECT id FROM accounts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
  if (!account) return undefined;
  const blocked = await deletionBlockers(db, id);
  if (blocked) return blocked;
  await leaveAllTeams(db, id);
  await db.query(`UPDATE accounts SET enabled = false, security_epoch = security_epoch + 1, deleted_at = now(),
    email = 'deleted-' || id || '@deleted.invalid', display_name = NULL, password_hash = 'deleted',
    totp_secret = NULL, totp_confirmed_at = NULL, email_verified_at = NULL WHERE id = $1`, [id]);
  for (const table of ['oidc_records', 'web_sessions', 'agent_tokens', 'account_links', 'application_accounts', 'email_changes']) {
    await db.query(`DELETE FROM ${table} WHERE account_id = $1`, [id]);
  }
  await db.query('DELETE FROM invitations WHERE invited_by = $1 AND accepted_at IS NULL', [id]);
  await audit(db, 'account.deleted', id, actor);
  return null;
}

// Deletes the accounts whose waiting period is over. An account that became blocked in the
// meantime stays, with its request, until its owner or an administrator resolves it.
export async function sweepDeletions(pool: Pool, notifier?: Pick<Notifier, 'account'>, graceSeconds = deletionGraceSeconds) {
  const due = (await pool.query<{ id: string }>(
    `SELECT id FROM accounts WHERE deleted_at IS NULL AND deletion_requested_at <= now() - $1 * interval '1 second'`, [graceSeconds])).rows;
  let deleted = 0;
  for (const { id } of due) {
    const outcome = await transaction(pool, async (db) => {
      const still = await db.query(
        `SELECT 1 FROM accounts WHERE id = $1 AND deleted_at IS NULL AND deletion_requested_at <= now() - $2 * interval '1 second' FOR UPDATE`,
        [id, graceSeconds]);
      return still.rowCount ? deleteAccount(db, id) : undefined;
    });
    if (outcome === null) {
      deleted += 1;
      notifier?.account(id);
    }
  }
  return deleted;
}
