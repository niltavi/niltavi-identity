import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { errors } from 'oidc-provider';
import type { Adapter, AdapterPayload } from 'oidc-provider';
import type { Pool } from 'pg';

const readable = `
  SELECT r.account_id, r.account_epoch, r.payload || CASE
    WHEN r.consumed_at IS NULL THEN '{}'::jsonb
    ELSE jsonb_build_object('consumed', floor(extract(epoch FROM r.consumed_at)))
  END AS payload
  FROM oidc_records r
  LEFT JOIN accounts a ON a.id = r.account_id
  WHERE r.model = $1
    AND (r.expires_at IS NULL OR r.expires_at > clock_timestamp())
    AND (r.account_id IS NULL OR (a.enabled AND a.security_epoch = r.account_epoch))
`;

function storageKey(id: string) {
  return createHash('sha256').update(id).digest('hex');
}

export type ClientLookup = (id: string) => Promise<AdapterPayload | undefined>;
export type CentralSession = { key: string; signedInAt: Date | null; expiresAt: Date | null; apps: Array<{ id: string; sid: string }> };

export function createProtocolStore(pool: Pool, realm?: string, clients?: ClientLookup) {
  const requests = new AsyncLocalStorage<Map<string, number>>();
  const prefix = realm ? `${storageKey(realm)}:` : '';

  function remember(accountId: string, epoch: number) {
    const observed = requests.getStore();
    const prior = observed?.get(accountId);
    if (prior !== undefined) return prior === epoch;
    observed?.set(accountId, epoch);
    return true;
  }

  class PostgresAdapter implements Adapter {
    private readonly model: string;
    private readonly replayDetection: boolean;
    private readonly registry: boolean;

    constructor(model: string) {
      this.model = `${prefix}${model}`;
      this.replayDetection = model === 'ReplayDetection';
      // Registered applications live in their own table, so a new registration works without a restart.
      this.registry = model === 'Client';
    }

    async upsert(id: string, payload: AdapterPayload, expiresIn?: number) {
      const accountId = payload.accountId ?? payload.result?.login?.accountId ?? payload.session?.accountId ?? null;
      const epoch = accountId === null ? null : requests.getStore()?.get(accountId) ?? null;
      // Take the account lock before writing an account-bound object. A request
      // that observed an earlier account generation cannot write after re-enable.
      const result = await pool.query(
        `WITH allowed AS (
           SELECT id, security_epoch FROM accounts
           WHERE id = $5::text AND enabled AND ($6::integer IS NULL OR security_epoch = $6)
           FOR SHARE
         )
         INSERT INTO oidc_records
           (model, storage_key, payload, expires_at, account_id, account_epoch)
         SELECT $1, $2, $3::jsonb, clock_timestamp() + $4::integer * interval '1 second',
                a.id, a.security_epoch
         FROM (SELECT 1) request LEFT JOIN allowed a ON true
         WHERE $5::text IS NULL OR a.id IS NOT NULL
         ON CONFLICT (model, storage_key) DO UPDATE
         SET payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at,
             account_id = EXCLUDED.account_id, account_epoch = EXCLUDED.account_epoch,
             consumed_at = CASE WHEN $7::boolean THEN NULL ELSE oidc_records.consumed_at END
         WHERE NOT $7::boolean OR oidc_records.expires_at <= clock_timestamp()`,
        [this.model, storageKey(id), JSON.stringify(payload), expiresIn ?? null, accountId, epoch, this.replayDetection],
      );
      if (result.rowCount !== 1) {
        throw new errors.InvalidGrant('The grant is no longer available');
      }
    }

    find(id: string) {
      if (this.registry) return clients?.(id) ?? Promise.resolve(undefined);
      return this.read('r.storage_key', storageKey(id));
    }

    findByUid(uid: string) {
      return this.read("(r.payload ->> 'uid')", uid);
    }

    findByUserCode(code: string) {
      return this.read("(r.payload ->> 'userCode')", code);
    }

    private async read(column: string, value: string) {
      const result = await pool.query<{
        payload: AdapterPayload; account_id: string | null; account_epoch: number | null;
      }>(`${readable} AND ${column} = $2`, [this.model, value]);
      const row = result.rows[0];
      if (row?.account_id && row.account_epoch !== null && !remember(row.account_id, row.account_epoch)) {
        return undefined;
      }
      return row?.payload;
    }

    async consume(id: string) {
      const result = await pool.query(
        `UPDATE oidc_records SET consumed_at = clock_timestamp()
         WHERE model = $1 AND storage_key = $2 AND consumed_at IS NULL
           AND (expires_at IS NULL OR expires_at > clock_timestamp())`,
        [this.model, storageKey(id)],
      );
      if (result.rowCount !== 1) {
        throw new errors.InvalidGrant('The grant is no longer available');
      }
    }

    async destroy(id: string) {
      await pool.query('DELETE FROM oidc_records WHERE model = $1 AND storage_key = $2', [
        this.model, storageKey(id),
      ]);
    }

    async revokeByGrantId(grantId: string) {
      await pool.query("DELETE FROM oidc_records WHERE model = $1 AND payload ->> 'grantId' = $2", [
        this.model, grantId,
      ]);
    }
  }

  async function isEnabled(id: string) {
    const result = await pool.query<{ security_epoch: number }>(
      'SELECT security_epoch FROM accounts WHERE id = $1 AND enabled', [id],
    );
    const account = result.rows[0];
    return account !== undefined && remember(id, account.security_epoch);
  }

  const live = `(r.expires_at IS NULL OR r.expires_at > clock_timestamp()) AND a.enabled AND a.security_epoch = r.account_epoch`;
  const sessionModel = `${prefix}Session`;

  // A central session is the browser's sign-in at Identity. Each application it opened holds its own sid.
  async function sessions(account: string): Promise<CentralSession[]> {
    const result = await pool.query<{ storage_key: string; payload: AdapterPayload; expires_at: Date | null }>(
      `SELECT r.storage_key, r.payload, r.expires_at FROM oidc_records r JOIN accounts a ON a.id = r.account_id
       WHERE r.model = $1 AND r.account_id = $2 AND ${live} ORDER BY r.payload ->> 'loginTs' DESC`, [sessionModel, account]);
    return result.rows.map(({ storage_key: key, payload, expires_at: expiresAt }) => ({
      key, expiresAt,
      signedInAt: typeof payload.loginTs === 'number' ? new Date(payload.loginTs * 1_000) : null,
      apps: Object.entries((payload.authorizations ?? {}) as Record<string, { sid?: string }>)
        .flatMap(([id, entry]) => entry.sid ? [{ id, sid: entry.sid }] : []),
    }));
  }

  async function sessionActive(account: string, client: string, sid: string) {
    return Boolean((await pool.query(
      `SELECT 1 FROM oidc_records r JOIN accounts a ON a.id = r.account_id
       WHERE r.model = $1 AND r.account_id = $2 AND ${live} AND r.payload -> 'authorizations' -> $3 ->> 'sid' = $4`,
      [sessionModel, account, client, sid])).rowCount);
  }

  // Ends one central session and everything issued under it. Returns the applications to notify.
  async function endSession(account: string, key: string) {
    const removed = (await pool.query<{ payload: AdapterPayload }>(
      'DELETE FROM oidc_records WHERE model = $1 AND account_id = $2 AND storage_key = $3 RETURNING payload',
      [sessionModel, account, key])).rows[0];
    if (!removed) return undefined;
    const entries = Object.entries((removed.payload.authorizations ?? {}) as Record<string, { sid?: string; grantId?: string }>);
    const grants = entries.flatMap(([, entry]) => entry.grantId ? [entry.grantId] : []);
    if (grants.length) {
      await pool.query(`DELETE FROM oidc_records WHERE account_id = $1 AND starts_with(model, $3)
        AND (payload ->> 'grantId' = ANY($2::text[]) OR payload ->> 'jti' = ANY($2::text[]))`, [account, grants, prefix]);
    }
    return entries.flatMap(([id, entry]) => entry.sid ? [{ id, sid: entry.sid }] : []);
  }

  // The client an authorization request named, read even after the request has expired.
  async function interactionClient(uid: string) {
    return (await pool.query<{ client: string | null }>(
      "SELECT payload -> 'params' ->> 'client_id' AS client FROM oidc_records WHERE model = $1 AND storage_key = $2",
      [`${prefix}Interaction`, storageKey(uid)])).rows[0]?.client ?? undefined;
  }

  return {
    Adapter: PostgresAdapter,
    sessions, sessionActive, endSession, interactionClient,
    isEnabled,
    remember,
    request<T>(work: () => T) { return requests.run(new Map(), work); },
  };
}

export type ProtocolStore = ReturnType<typeof createProtocolStore>;
