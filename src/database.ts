import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { normalizeEmail, passwordHash, sealClientSecret } from './credentials.js';
import { digest } from './browser-cookie.js';
import { httpsUrl } from './settings.js';

export type Queryable = Pool | PoolClient;
export interface Application {
  id: string;
  name: string;
  home_url: string;
  sign_in_name: string | null;
  sign_in_logo_url: string | null;
  enabled: boolean;
  callback: string;
  post_logout: string;
  backchannel_logout: string;
  resource: string;
  secret_ciphertext: string;
}

export function connect(connectionString: string) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5_000, max: 12 });
  pool.on('error', () => { console.error('An idle PostgreSQL connection was closed.'); });
  return pool;
}

export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const outcome = await work(client);
    await client.query('COMMIT');
    return outcome;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Audit rows name the action, the affected record and the acting account. Never pass a
// password, code, token or request parameter as the target or the detail.
export async function audit(db: Queryable, action: string, target: string, actor?: string, detail?: string) {
  if (actor) await db.query('INSERT INTO audit_events (action, target, actor, detail) VALUES ($1, $2, $3, $4)', [action, target, actor, detail ?? null]);
  else await db.query('INSERT INTO audit_events (action, target, detail) VALUES ($1, $2, $3)', [action, target, detail ?? null]);
}

const migrationFiles = ['schema.sql', 'schema-browser.sql', 'schema-enrollment.sql', 'schema-registration-intents.sql',
  'schema-teams.sql', 'schema-email-codes.sql', 'schema-registration-policy.sql', 'schema-application-branding.sql',
  'schema-disable-2fa-codes.sql', 'schema-login-second-factor.sql'];
export const schemaVersion = migrationFiles.length;

// Serialize first-account ownership, operator provisioning and registration policy changes.
export async function lockInstanceAdministration(db: PoolClient) {
  await db.query('SELECT pg_advisory_xact_lock(2026112402)');
}

export async function getSetting<T>(db: Queryable, key: string) {
  return (await db.query<{ value: T }>('SELECT value FROM instance_settings WHERE key = $1', [key])).rows[0]?.value;
}

export async function setSetting(db: Queryable, key: string, value: unknown) {
  if (value === undefined) await db.query('DELETE FROM instance_settings WHERE key = $1', [key]);
  else await db.query(`INSERT INTO instance_settings (key, value) VALUES ($1, $2::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]);
}

// Every account owns a personal space from the moment it exists.
export async function insertAccount(db: Queryable, email: string, hash: string | null, verified: boolean) {
  const id = randomUUID();
  const inserted = await db.query(
    `INSERT INTO accounts (id, email, password_hash, email_verified_at) VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END)
     ON CONFLICT (email) DO NOTHING`, [id, email, hash, verified]);
  if (!inserted.rowCount) return undefined;
  const org = randomUUID();
  await db.query("INSERT INTO orgs (id, name, personal_account_id) VALUES ($1, 'Personal', $2)", [org, id]);
  await db.query("INSERT INTO memberships (org_id, account_id, role) VALUES ($1, $2, 'owner')", [org, id]);
  return id;
}

export async function migrate(pool: Pool) {
  const files = migrationFiles;
  const schemas = await Promise.all(files.map((file) => readFile(new URL(`../src/${file}`, import.meta.url), 'utf8')));
  return transaction(pool, async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(2026112101)');
    await db.query('CREATE TABLE IF NOT EXISTS identity_migrations (version integer PRIMARY KEY)');
    let changed = false;
    for (const [index, schema] of schemas.entries()) {
      const version = index + 1;
      if ((await db.query('SELECT 1 FROM identity_migrations WHERE version = $1', [version])).rowCount) continue;
      await db.query(schema);
      await db.query('INSERT INTO identity_migrations (version) VALUES ($1)', [version]);
      changed = true;
    }
    return { version: schemas.length, changed };
  });
}

export async function assertSchema(pool: Pool) {
  if (!(await pool.query('SELECT 1 FROM identity_migrations WHERE version = $1', [schemaVersion])).rowCount) {
    throw new Error('Run identity migrate before serving traffic.');
  }
}

export async function createAccount(pool: Pool, address: string, password: string) {
  const email = normalizeEmail(address);
  const hash = await passwordHash(password, email);
  return transaction(pool, async (db) => {
    await lockInstanceAdministration(db);
    const id = await insertAccount(db, email, hash, false);
    if (!id) throw new Error('An account already uses this email.');
    await audit(db, 'account.created', id);
    return { id, email, enabled: true };
  });
}

export async function getAccount(pool: Pool, address: string) {
  const result = await pool.query<{ id: string; email: string; enabled: boolean; security_epoch: number }>(
    'SELECT id, email, enabled, security_epoch FROM accounts WHERE email = $1', [normalizeEmail(address)],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Account does not exist.');
  return row;
}

export async function setAccountEnabled(pool: Pool, address: string, enabled: boolean) {
  return transaction(pool, async (db) => {
    const account = (await db.query<{ id: string; enabled: boolean; security_epoch: number }>(
      'SELECT id, enabled, security_epoch FROM accounts WHERE email = $1 FOR UPDATE', [normalizeEmail(address)],
    )).rows[0];
    if (!account) throw new Error('Account does not exist.');
    return applyAccountEnabled(db, account, enabled);
  });
}

export async function applyAccountEnabled(db: PoolClient, account: { id: string; enabled: boolean; security_epoch: number },
  enabled: boolean, actor?: string) {
  if (account.enabled === enabled) return { ...account, changed: false };
  const epoch = account.security_epoch + 1;
  await db.query('UPDATE accounts SET enabled = $2, security_epoch = $3 WHERE id = $1', [account.id, enabled, epoch]);
  await db.query('DELETE FROM oidc_records WHERE account_id = $1', [account.id]);
  await db.query('DELETE FROM web_sessions WHERE account_id = $1', [account.id]);
  const action = enabled ? 'account.enabled' : 'account.disabled';
  await audit(db, action, account.id, actor);
  return { id: account.id, enabled, security_epoch: epoch, changed: true };
}

export async function grantAcceptanceOperator(pool: Pool, operatorAddress: string, targetAddress: string) {
  const operator = normalizeEmail(operatorAddress);
  const target = normalizeEmail(targetAddress);
  const domain = process.env.IDENTITY_ACCEPTANCE_OPERATOR_DOMAIN?.trim().toLowerCase();
  if (process.env.IDENTITY_DEPLOYMENT_PROFILE !== 'acceptance' || !domain) {
    throw new Error('Acceptance operator grants require the acceptance profile and a dedicated mailbox domain.');
  }
  const shared = process.env.IDENTITY_ACCEPTANCE_SHARED_EMAIL?.trim().toLowerCase();
  if (operator === target || [operator, target].some(email =>
    !email.endsWith('@' + domain) || email === 'acceptance@' + domain || email === shared)) {
    throw new Error('Use two different dedicated acceptance accounts. The shared account cannot be granted or targeted.');
  }
  return transaction(pool, async (db) => {
    const rows = await db.query<{ email: string; id: string }>('SELECT email, id FROM accounts WHERE email IN ($1, $2)', [operator, target]);
    const actor = rows.rows.find((row) => row.email === operator)?.id;
    const subject = rows.rows.find((row) => row.email === target)?.id;
    if (!actor || !subject) throw new Error('Both acceptance accounts must exist.');
    const result = await db.query(`INSERT INTO acceptance_account_operators (operator_id, account_id)
      VALUES ($1, $2) ON CONFLICT DO NOTHING`, [actor, subject]);
    if (result.rowCount) await db.query(`INSERT INTO audit_events (action, target, actor)
      VALUES ('acceptance.operator_granted', $1, $2)`, [subject, actor]);
    return { changed: Boolean(result.rowCount) };
  });
}

export async function resetAccountPassword(pool: Pool, address: string, password: string) {
  const hash = await passwordHash(password, normalizeEmail(address));
  return transaction(pool, async (db) => {
    const account = (await db.query<{ id: string; enabled: boolean; security_epoch: number }>(
      `UPDATE accounts SET password_hash = $2, security_epoch = security_epoch + 1
       WHERE email = $1 RETURNING id, enabled, security_epoch`, [normalizeEmail(address), hash],
    )).rows[0];
    if (!account) throw new Error('Account does not exist.');
    await db.query('DELETE FROM oidc_records WHERE account_id = $1', [account.id]);
    await db.query('DELETE FROM web_sessions WHERE account_id = $1', [account.id]);
    await audit(db, 'account.password_reset', account.id);
    return account;
  });
}

// Each rule is a counter key, its limit and its window in seconds. Every counter is
// charged even after one has tripped, so the outcome does not depend on rule order.
export async function rateAllowed(pool: Pool, rules: ReadonlyArray<readonly [key: string, limit: number, seconds?: number]>) {
  let allowed = true;
  for (const [key, limit, seconds = 60] of rules) {
    const result = await pool.query<{ count: number }>(
      `INSERT INTO login_attempts (fingerprint, count, expires_at) VALUES ($1, 1, now() + $3 * interval '1 second')
       ON CONFLICT (fingerprint) DO UPDATE SET
         count = CASE WHEN login_attempts.expires_at <= now() THEN 1 ELSE least(login_attempts.count + 1, $2 + 1) END,
         expires_at = CASE WHEN login_attempts.expires_at <= now() THEN EXCLUDED.expires_at ELSE login_attempts.expires_at END
       RETURNING count`, [createHash('sha256').update(key).digest('hex'), limit, seconds]);
    if ((result.rows[0]?.count ?? limit + 1) > limit) allowed = false;
  }
  return allowed;
}

// Password attempts are limited per account (10 a minute, 60 an hour) and per source.
// The answer depends only on the submitted address, so it says nothing about the account.
export function loginRateAllowed(pool: Pool, source: string, email: string, purpose = 'login', limit = 60) {
  return rateAllowed(pool, purpose === 'login' ? [
    [`login:address:${email}`, 10], [`login:source:${source}`, limit], [`login-hour:address:${email}`, 60, 3_600],
  ] : [[`${purpose}:address:${email}`, limit], [`${purpose}:source:${source}`, limit]]);
}

export async function getLogin(pool: Pool, email: string) {
  return (await pool.query<{ id: string; security_epoch: number; enabled: boolean; password_hash: string | null; second_factor: boolean }>(
    'SELECT id, security_epoch, enabled, password_hash, totp_confirmed_at IS NOT NULL AS second_factor FROM accounts WHERE email = $1', [email],
  )).rows[0];
}

export type ApplicationSpec = {
  id: string; name: string; homeUrl: string; callback: string; postLogout: string; backchannel: string; resource: string;
};

// The SDK serves these paths, so registering an application needs only its ID, name and home URL.
export function standardApplication(id: string, name: string, home: string): ApplicationSpec {
  const { origin } = httpsUrl(home, 'Application URL');
  return { id, name, homeUrl: home, callback: `${origin}/auth/callback`, postLogout: `${origin}/auth/signed-out`,
    backchannel: `${origin}/auth/notifications`, resource: `${origin}/api` };
}

export async function registerApplication(pool: Pool, key: Buffer, spec: ApplicationSpec, actor?: string) {
  const { id } = spec;
  const name = spec.name.trim();
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(id)) throw new Error('Use a lowercase client ID of 3–64 characters.');
  if (!name || [...name].length > 80) throw new Error('Give the application a name of at most 80 characters.');
  const urls = [spec.callback, spec.postLogout, spec.backchannel, spec.resource, spec.homeUrl]
    .map((value) => httpsUrl(value, 'Application URL'));
  const origin = urls[0]?.origin;
  if (urls.some((url) => url.origin !== origin)) throw new Error('The application URLs must use the same origin.');
  const secret = randomBytes(32).toString('base64url');
  return transaction(pool, async (db) => {
    const inserted = await db.query(
      `INSERT INTO applications (id, callback, post_logout, backchannel_logout, resource, home_url, name, secret_ciphertext)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING RETURNING id`,
      [id, ...urls.map((url) => url.href), name, sealClientSecret(id, secret, key)],
    );
    if (!inserted.rowCount) throw new Error('An application already uses this client ID or endpoint.');
    await audit(db, 'application.registered', id, actor);
    return { client_id: id, client_secret: secret };
  });
}

export async function rotateApplicationSecret(pool: Pool, key: Buffer, id: string, actor?: string) {
  const secret = randomBytes(32).toString('base64url');
  return transaction(pool, async (db) => {
    const changed = await db.query('UPDATE applications SET secret_ciphertext = $2 WHERE id = $1', [id, sealClientSecret(id, secret, key)]);
    if (!changed.rowCount) throw new Error('Application does not exist.');
    await audit(db, 'application.secret_rotated', id, actor);
    return { client_id: id, client_secret: secret };
  });
}

export async function setApplicationBranding(pool: Pool, id: string, name: string, logo: string, actor?: string) {
  const signInName = name.trim();
  if ([...signInName].length > 80) throw new Error('Give the sign-in name at most 80 characters.');
  const signInLogoUrl = logo.trim() ? httpsUrl(logo.trim(), 'Sign-in logo URL').href : null;
  return transaction(pool, async (db) => {
    const updated = await db.query('UPDATE applications SET sign_in_name = $2, sign_in_logo_url = $3 WHERE id = $1',
      [id, signInName || null, signInLogoUrl]);
    if (!updated.rowCount) return false;
    await audit(db, 'application.branding_updated', id, actor);
    return true;
  });
}

export async function setApplicationEnabled(pool: Pool, id: string, enabled: boolean, actor?: string) {
  return transaction(pool, async (db) => {
    const changed = await db.query('UPDATE applications SET enabled = $2 WHERE id = $1 AND enabled <> $2', [id, enabled]);
    if (changed.rowCount) await audit(db, enabled ? 'application.enabled' : 'application.disabled', id, actor);
    return { changed: Boolean(changed.rowCount) };
  });
}

export async function listApplications(pool: Pool) {
  return (await pool.query<Application>('SELECT * FROM applications ORDER BY id')).rows;
}

const linkSeconds = { reset: 1_800, verify: 86_400 } as const;

// Issues a single-use link token. A new link replaces the account's earlier links of the same purpose.
export async function issueAccountLink(db: Queryable, account: string, email: string, purpose: 'reset' | 'verify',
  seconds: number = linkSeconds[purpose]) {
  const token = randomBytes(32).toString('base64url');
  await db.query('DELETE FROM account_links WHERE (account_id = $1 AND purpose = $2) OR expires_at <= now()', [account, purpose]);
  await db.query(`INSERT INTO account_links (token_digest, account_id, purpose, email, expires_at)
    VALUES ($1, $2, $3, $4, now() + $5 * interval '1 second')`, [digest(`${purpose}:${token}`), account, purpose, email, seconds]);
  return token;
}

// Operators recover an account without SMTP by handing its owner a one-time link.
export async function operatorResetLink(pool: Pool, address: string, issuer: string, actor?: string) {
  return transaction(pool, async (db) => {
    const account = (await db.query<{ id: string; email: string }>(
      'SELECT id, email FROM accounts WHERE email = $1 AND deleted_at IS NULL', [normalizeEmail(address)])).rows[0];
    if (!account) throw new Error('Account does not exist.');
    const token = await issueAccountLink(db, account.id, account.email, 'reset', 86_400);
    await audit(db, 'account.reset_link_issued', account.id, actor);
    return { link: `${new URL(issuer).origin}/reset#${token}`, expiresInSeconds: 86_400 };
  });
}

export async function markEmailVerified(pool: Pool, address: string, actor?: string) {
  return transaction(pool, async (db) => {
    const account = (await db.query<{ id: string }>(
      'UPDATE accounts SET email_verified_at = now() WHERE email = $1 AND email_verified_at IS NULL RETURNING id', [normalizeEmail(address)])).rows[0];
    if (account) await audit(db, 'account.email_verified_by_operator', account.id, actor);
    return { changed: Boolean(account) };
  });
}

// The first instance administrator becomes the owner, and the instance counts as initialized.
export async function setInstanceRole(pool: Pool, address: string, grant: boolean, actor?: string) {
  return transaction(pool, async (db) => {
    await lockInstanceAdministration(db);
    const account = (await db.query<{ id: string; instance_role: string | null }>(
      'SELECT id, instance_role FROM accounts WHERE email = $1 AND deleted_at IS NULL FOR UPDATE', [normalizeEmail(address)])).rows[0];
    if (!account) throw new Error('Account does not exist.');
    const owners = (await db.query("SELECT 1 FROM accounts WHERE instance_role = 'owner' AND id <> $1", [account.id])).rowCount;
    if (!grant && account.instance_role === 'owner' && !owners) throw new Error('The instance needs at least one owner.');
    const role = grant ? account.instance_role ?? (owners ? 'admin' : 'owner') : null;
    if (role === account.instance_role) return { id: account.id, role, changed: false };
    await db.query('UPDATE accounts SET instance_role = $2 WHERE id = $1', [account.id, role]);
    if (role) await setSetting(db, 'initialized', true);
    await audit(db, role ? 'instance.admin_granted' : 'instance.admin_revoked', account.id, actor, role ?? undefined);
    return { id: account.id, role, changed: true };
  });
}

export async function clearSecondFactor(pool: Pool, address: string) {
  return transaction(pool, async (db) => {
    const account = (await db.query<{ id: string }>(
      `UPDATE accounts SET totp_secret = NULL, totp_confirmed_at = NULL, totp_last_step = NULL
        WHERE email = $1 AND totp_secret IS NOT NULL RETURNING id`, [normalizeEmail(address)])).rows[0];
    if (account) {
      await db.query('UPDATE web_sessions SET second_factor_at = NULL WHERE account_id = $1', [account.id]);
      await audit(db, 'account.second_factor_removed', account.id);
    }
    return { changed: Boolean(account) };
  });
}

export async function listAudit(pool: Pool) {
  return (await pool.query('SELECT event_id, action, target, actor, detail, occurred_at FROM audit_events ORDER BY event_id')).rows;
}
