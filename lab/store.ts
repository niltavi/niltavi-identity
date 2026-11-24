import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createProtocolStore } from '../src/protocol-store.js';

const schemaSql = new URL('./schema.sql', import.meta.url);

export async function createLabStore(connectionString: string, accountId: string) {
  if (new URL(connectionString).pathname !== '/identity_lab') {
    throw new Error('The lab requires a dedicated identity_lab database.');
  }
  const schema = `identity_lab_${randomBytes(8).toString('hex')}`;
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, connectionTimeoutMillis: 5_000 });
  const close = async () => {
    try {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  };
  try {
    const sql = await readFile(schemaSql, 'utf8');
    await pool.query(`CREATE SCHEMA "${schema}";\n${sql}`);
    await pool.query('INSERT INTO accounts (id) VALUES ($1)', [accountId]);
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }

  async function disableAccount(id: string) {
    const transaction = await pool.connect();
    try {
      await transaction.query('BEGIN');
      const updated = await transaction.query(
        'UPDATE accounts SET enabled = false, security_epoch = security_epoch + 1 WHERE id = $1 AND enabled',
        [id],
      );
      if (updated.rowCount === 1) {
        await transaction.query('DELETE FROM oidc_records WHERE account_id = $1', [id]);
      }
      await transaction.query('COMMIT');
      return updated.rowCount === 1;
    } catch (error) {
      await transaction.query('ROLLBACK');
      throw error;
    } finally {
      transaction.release();
    }
  }

  return { ...createProtocolStore(pool), disableAccount, close };
}

export type LabStore = Awaited<ReturnType<typeof createLabStore>>;
