import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { normalizeEmail, passwordHash, sealClientSecret } from './credentials.js';
import { httpsUrl } from './settings.js';

type Queryable = Pool | PoolClient;
export interface Application {
  id: string;
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

async function audit(db: Queryable, action: string, target: string) {
  await db.query('INSERT INTO audit_events (action, target) VALUES ($1, $2)', [action, target]);
}

export async function migrate(pool: Pool) {
  const files = ['schema.sql', 'schema-browser.sql'];
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
  if (!(await pool.query('SELECT 1 FROM identity_migrations WHERE version = 2')).rowCount) {
    throw new Error('Run identity migrate before serving traffic.');
  }
}

export async function createAccount(pool: Pool, address: string, password: string) {
  const email = normalizeEmail(address);
  const id = randomUUID();
  const hash = await passwordHash(password);
  return transaction(pool, async (db) => {
    const inserted = await db.query(
      `INSERT INTO accounts (id, email, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING RETURNING id`,
      [id, email, hash],
    );
    if (!inserted.rowCount) throw new Error('An account already uses this email.');
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
  if (actor) await db.query('INSERT INTO audit_events (action, target, actor) VALUES ($1, $2, $3)', [action, account.id, actor]);
  else await audit(db, action, account.id);
  return { id: account.id, enabled, security_epoch: epoch, changed: true };
}

export async function grantAcceptanceOperator(pool: Pool, operatorAddress: string, targetAddress: string) {
  const operator = normalizeEmail(operatorAddress);
  const target = normalizeEmail(targetAddress);
  if (operator === target || [operator, target].some((email) => !email.endsWith('@niltavi.test') || email === 'acceptance@niltavi.test')) {
    throw new Error('Use two different dedicated niltavi.test accounts. The shared account cannot be granted or targeted.');
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
  const hash = await passwordHash(password);
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

export async function loginRateAllowed(pool: Pool, source: string, email: string, purpose = 'login', limit = 60) {
  const keys = [`${purpose}:address:${email}`, `${purpose}:source:${source}`].map(
    (value) => createHash('sha256').update(value).digest('hex'),
  );
  const result = await pool.query<{ count: number }>(
    `INSERT INTO login_attempts (fingerprint, count, expires_at)
     SELECT key, 1, now() + interval '1 minute' FROM unnest($1::text[]) AS key
     ON CONFLICT (fingerprint) DO UPDATE SET
       count = CASE WHEN login_attempts.expires_at <= now() THEN 1 ELSE least(login_attempts.count + 1, $2 + 1) END,
       expires_at = CASE WHEN login_attempts.expires_at <= now() THEN EXCLUDED.expires_at ELSE login_attempts.expires_at END
     RETURNING count`, [keys, limit],
  );
  return result.rows.every(({ count }) => count <= limit);
}

export async function getLogin(pool: Pool, email: string) {
  return (await pool.query<{ id: string; security_epoch: number; enabled: boolean; password_hash: string }>(
    'SELECT id, security_epoch, enabled, password_hash FROM accounts WHERE email = $1', [email],
  )).rows[0];
}

export async function registerApplication(
  pool: Pool, key: Buffer, id: string, callback: string, postLogout: string, backchannel: string, resource: string,
) {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(id)) throw new Error('Use a lowercase client ID of 3–64 characters.');
  const urls = [callback, postLogout, backchannel, resource].map((value) => httpsUrl(value, 'Application URL'));
  const origin = urls[0]?.origin;
  if (urls.some((url) => url.origin !== origin)) throw new Error('The four application URLs must use the same origin.');
  const secret = randomBytes(32).toString('base64url');
  return transaction(pool, async (db) => {
    const inserted = await db.query(
      `INSERT INTO applications (id, callback, post_logout, backchannel_logout, resource, secret_ciphertext)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING id`,
      [id, ...urls.map((url) => url.href), sealClientSecret(id, secret, key)],
    );
    if (!inserted.rowCount) throw new Error('An application already uses this client ID or endpoint.');
    await audit(db, 'application.registered', id);
    return { client_id: id, client_secret: secret };
  });
}

export async function listApplications(pool: Pool) {
  return (await pool.query<Application>('SELECT * FROM applications ORDER BY id')).rows;
}

export async function listAudit(pool: Pool) {
  return (await pool.query('SELECT event_id, action, target, actor, occurred_at FROM audit_events ORDER BY event_id')).rows;
}
