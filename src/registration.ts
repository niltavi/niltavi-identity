import type { PoolClient } from 'pg';
import { audit, getSetting, insertAccount, lockInstanceAdministration, setSetting } from './database.js';
import type { Queryable } from './database.js';

export type RegistrationPolicy = 'open' | 'invite' | 'closed';

export async function registrationPolicy(db: Queryable): Promise<RegistrationPolicy> {
  return await getSetting<RegistrationPolicy>(db, 'registration') ?? 'open';
}

export async function registrationRefusal(db: Queryable, email: string, invitationDigest: string | null) {
  const policy = await registrationPolicy(db);
  if (policy === 'closed') return 'registration_unavailable';
  if (policy === 'invite') {
    const invited = invitationDigest && (await db.query(
      `SELECT 1 FROM invitations WHERE token_digest = $1 AND email = $2
        AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR SHARE`,
      [invitationDigest, email])).rowCount;
    if (!invited) return 'invitation_required';
  }
}

export async function registerNewAccount(db: PoolClient, email: string, hash: string | null,
  verified: boolean, invitationDigest: string | null) {
  await lockInstanceAdministration(db);
  const refused = await registrationRefusal(db, email, invitationDigest);
  if (refused) return { error: refused } as const;

  // Keep deleted accounts and completed setup from making an instance claimable again.
  const first = !await getSetting<boolean>(db, 'initialized') && !(await db.query('SELECT 1 FROM accounts LIMIT 1')).rowCount;
  const id = await insertAccount(db, email, hash, verified);
  if (!id) return { error: 'email_in_use' } as const;
  if (first) {
    await db.query("UPDATE accounts SET instance_role = 'owner' WHERE id = $1", [id]);
    await setSetting(db, 'initialized', true);
    await setSetting(db, 'setup_link', undefined);
    await audit(db, 'instance.admin_granted', id, id, 'owner');
    await audit(db, 'instance.initialized', 'instance', id);
  }
  return { id } as const;
}
