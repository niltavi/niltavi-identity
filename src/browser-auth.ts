import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import nodemailer from 'nodemailer';
import type { Pool } from 'pg';
import { normalizeEmail, passwordHash, verifyPassword } from './credentials.js';
import { applyAccountEnabled, getLogin, loginRateAllowed, transaction } from './database.js';
import { httpsUrl } from './settings.js';

const sessionCookie = '__Host-niltavi-session';
const sessionSeconds = 43_200;
const digest = (value: string) => createHash('sha256').update(value).digest('base64url');

type Session = {
  id: string;
  email: string;
  emailVerified: boolean;
  signedInAt: Date;
  expiresAt: Date;
  activeSessions: number;
};

function emailAddress(value: string) {
  const email = normalizeEmail(value);
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email)) throw new Error('Invalid email.');
  return email;
}

function sessionKey(request: FastifyRequest, keyForToken: (value: string) => string) {
  const value = request.headers.cookie?.split(';').map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${sessionCookie}=`))?.slice(sessionCookie.length + 1);
  return value && /^[\w-]{43}$/.test(value) ? keyForToken(value) : undefined;
}

function setCookie(reply: FastifyReply, value: string, maxAge: number) {
  reply.header('set-cookie', `${sessionCookie}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`);
}

async function session(pool: Pool, key: string | undefined) {
  if (!key) return undefined;
  return (await pool.query<Session>(
    `SELECT a.id, a.email, a.email_verified_at IS NOT NULL AS "emailVerified",
            s.created_at AS "signedInAt", s.expires_at AS "expiresAt",
            (SELECT count(*)::int FROM web_sessions active WHERE active.account_id = a.id
              AND active.expires_at > now() AND active.account_epoch = a.security_epoch) AS "activeSessions"
     FROM web_sessions s JOIN accounts a ON a.id = s.account_id
     WHERE s.token_digest = $1 AND s.expires_at > now() AND a.enabled AND a.security_epoch = s.account_epoch`, [key],
  )).rows[0];
}

async function mailDelivery() {
  const file = process.env.IDENTITY_SMTP_URL_FILE;
  if (!file) return undefined;
  const url = new URL((await readFile(file, 'utf8')).trim());
  if (!['smtp:', 'smtps:'].includes(url.protocol) || !url.hostname || url.pathname && url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use a plain SMTP transport URL.');
  }
  const from = emailAddress(process.env.IDENTITY_SMTP_FROM ?? '');
  const secure = url.protocol === 'smtps:';
  const caFile = process.env.IDENTITY_SMTP_CA_FILE;
  const transporter = nodemailer.createTransport({
    host: url.hostname, port: Number(url.port || (secure ? 465 : 587)), secure, requireTLS: !secure,
    connectionTimeout: 8_000, greetingTimeout: 8_000, socketTimeout: 12_000,
    ...(url.username ? { auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } } : {}),
    ...(caFile ? { tls: { ca: await readFile(caFile) } } : {}),
    disableFileAccess: true, disableUrlAccess: true,
  });
  return async (to: string, token: string) => {
    const result = await transporter.sendMail({ from, to, subject: 'Verify your Niltavi Identity account',
      text: `Enter this verification code in Niltavi Identity within 15 minutes:\n\n${token}\n\nIf you did not request an account, ignore this message.`,
    });
    if (!result.accepted.length) throw new Error('SMTP did not accept the message.');
  };
}

function body(request: FastifyRequest, ...keys: string[]) {
  const data = request.body;
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== keys.length) return undefined;
  const values = data as Record<string, unknown>;
  const fields = keys.map((key) => values[key]);
  return fields.every((value) => typeof value === 'string') ? fields as string[] : undefined;
}

function failure(reply: FastifyReply, status: number, error: string) {
  return reply.code(status).send({ error });
}

export async function registerBrowserAuth(app: FastifyInstance, pool: Pool, issuer: URL, backupHash: string, realm?: string) {
  const keyForToken = (token: string) => digest(realm ? `${realm}\0${token}` : token);
  const cookie = (request: FastifyRequest) => sessionKey(request, keyForToken);
  const deliver = await mailDelivery();
  const allowedDomain = process.env.IDENTITY_REGISTRATION_DOMAIN?.trim().toLowerCase();
  if (allowedDomain) emailAddress(`mail@${allowedDomain}`);
  const applications = [['应用 A', process.env.IDENTITY_RP_A_URL], ['应用 B', process.env.IDENTITY_RP_B_URL]]
    .flatMap(([name, url]) => name && url ? [{ name, url: httpsUrl(url, 'Application URL').href }] : []);
  const origin = async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers.origin !== issuer.origin) return failure(reply, 403, 'unexpected_origin');
    if (request.headers['content-type']?.split(';', 1)[0] !== 'application/json') {
      return failure(reply, 415, 'json_required');
    }
  };

  app.get('/account/config', async () => ({ registrationAvailable: Boolean(deliver), registrationDomain: allowedDomain,
    managedAccounts: process.env.IDENTITY_ACCEPTANCE_OPERATORS === 'true', applications }));
  app.get('/account/session', async (request, reply) => {
    const key = cookie(request);
    const current = await session(pool, key);
    if (current) return { account: current };
    if (key) setCookie(reply, '', 0);
    return failure(reply, 401, 'sign_in_required');
  });

  app.post('/account/register', { preHandler: origin }, async (request, reply) => {
    if (!deliver) return failure(reply, 503, 'registration_unavailable');
    const fields = body(request, 'email');
    let email: string;
    try { email = emailAddress(fields?.[0] ?? ''); }
    catch { return failure(reply, 400, 'invalid_email'); }
    if (allowedDomain && email.split('@')[1] !== allowedDomain) return failure(reply, 400, 'registration_domain');
    if (!await loginRateAllowed(pool, request.ip, email, 'register', 5)) return failure(reply, 429, 'try_later');
    if (!await getLogin(pool, email)) {
      const token = randomBytes(24).toString('base64url');
      const key = digest(token);
      await pool.query('DELETE FROM email_registrations WHERE expires_at <= now()');
      await pool.query(`INSERT INTO email_registrations VALUES ($1, $2, now() + interval '15 minutes')`, [key, email]);
      try { await deliver(email, token); }
      catch {
        await pool.query('DELETE FROM email_registrations WHERE token_digest = $1', [key]);
        return failure(reply, 503, 'delivery_unavailable');
      }
    }
    return reply.code(202).send({ accepted: true });
  });

  app.post('/account/verify', { preHandler: origin }, async (request, reply) => {
    const fields = body(request, 'email', 'code', 'password');
    let email: string;
    try { email = emailAddress(fields?.[0] ?? ''); }
    catch { return failure(reply, 400, 'invalid_email'); }
    const [, code, password] = fields ?? [];
    if (!code || !/^[\w-]{32}$/.test(code)) return failure(reply, 400, 'invalid_code');
    if (!await loginRateAllowed(pool, request.ip, email, 'verify', 12)) return failure(reply, 429, 'try_later');
    const key = digest(code);
    if (!(await pool.query('SELECT 1 FROM email_registrations WHERE email = $1 AND token_digest = $2 AND expires_at > now()',
      [email, key])).rowCount) return failure(reply, 400, 'invalid_code');
    let hash: string;
    try { hash = await passwordHash(password ?? ''); }
    catch { return failure(reply, 400, 'invalid_password'); }
    const created = await transaction(pool, async (db) => {
      if (!(await db.query('DELETE FROM email_registrations WHERE email = $1 AND token_digest = $2 AND expires_at > now()',
        [email, key])).rowCount) return false;
      const id = randomUUID();
      const result = await db.query(`INSERT INTO accounts (id, email, password_hash, email_verified_at)
        VALUES ($1, $2, $3, now()) ON CONFLICT (email) DO NOTHING`, [id, email, hash]);
      if (result.rowCount) await db.query(`INSERT INTO audit_events (action, target, actor)
        VALUES ('account.email_registered', $1, $1)`, [id]);
      return Boolean(result.rowCount);
    });
    return created ? reply.code(201).send({ created: true }) : failure(reply, 400, 'invalid_code');
  });

  app.post('/account/login', { preHandler: origin }, async (request, reply) => {
    const fields = body(request, 'email', 'password');
    let email: string;
    try { email = emailAddress(fields?.[0] ?? ''); }
    catch { return failure(reply, 400, 'invalid_email'); }
    if (!await loginRateAllowed(pool, request.ip, email)) return failure(reply, 429, 'try_later');
    const account = await getLogin(pool, email);
    const authentic = await verifyPassword(fields?.[1] ?? '', account?.password_hash ?? backupHash);
    if (!account?.enabled || !authentic) return failure(reply, 401, 'invalid_credentials');
    const token = randomBytes(32).toString('base64url');
    const previous = cookie(request);
    const established = await transaction(pool, async (db) => {
      const live = await db.query('SELECT 1 FROM accounts WHERE id = $1 AND enabled AND security_epoch = $2 FOR UPDATE',
        [account.id, account.security_epoch]);
      if (!live.rowCount) return false;
      if (previous) await db.query('DELETE FROM web_sessions WHERE token_digest = $1', [previous]);
      await db.query('DELETE FROM web_sessions WHERE account_id = $1 AND expires_at <= now()', [account.id]);
      await db.query(`INSERT INTO web_sessions (token_digest, account_id, account_epoch, expires_at)
        VALUES ($1, $2, $3, now() + $4 * interval '1 second')`, [keyForToken(token), account.id, account.security_epoch, sessionSeconds]);
      return true;
    });
    if (!established) return failure(reply, 401, 'invalid_credentials');
    setCookie(reply, token, sessionSeconds);
    return reply.code(204).send();
  });

  app.post('/account/logout', { preHandler: origin }, async (request, reply) => {
    const key = cookie(request);
    if (key) await pool.query('DELETE FROM web_sessions WHERE token_digest = $1', [key]);
    setCookie(reply, '', 0);
    return reply.code(204).send();
  });

  app.post('/account/end-sessions', { preHandler: origin }, async (request, reply) => {
    const key = cookie(request);
    if (!key) return failure(reply, 401, 'sign_in_required');
    const ended = await transaction(pool, async (db) => {
      const locked = await db.query<{ id: string }>(`SELECT a.id FROM web_sessions s JOIN accounts a ON a.id = s.account_id
        WHERE s.token_digest = $1 AND s.expires_at > now() AND a.enabled AND a.security_epoch = s.account_epoch FOR UPDATE OF a`, [key]);
      const account = locked.rows[0];
      if (!account) return false;
      const current = await db.query('SELECT 1 FROM web_sessions WHERE token_digest = $1 AND expires_at > now()', [key]);
      if (!current.rowCount) return false;
      await db.query('UPDATE accounts SET security_epoch = security_epoch + 1 WHERE id = $1', [account.id]);
      await db.query('DELETE FROM web_sessions WHERE account_id = $1', [account.id]);
      await db.query('DELETE FROM oidc_records WHERE account_id = $1', [account.id]);
      await db.query(`INSERT INTO audit_events (action, target, actor) VALUES ('account.sessions_ended', $1, $1)`, [account.id]);
      return true;
    });
    setCookie(reply, '', 0);
    return ended ? reply.code(204).send() : failure(reply, 401, 'sign_in_required');
  });

  if (process.env.IDENTITY_ACCEPTANCE_OPERATORS === 'true') {
    app.get('/account/managed', async (request, reply) => {
      const current = await session(pool, cookie(request));
      if (!current) return failure(reply, 401, 'sign_in_required');
      const result = await pool.query(`SELECT a.id, a.email, a.enabled FROM acceptance_account_operators p
        JOIN accounts a ON a.id = p.account_id WHERE p.operator_id = $1 ORDER BY a.email`, [current.id]);
      return { accounts: result.rows };
    });

    app.post<{ Params: { id: string } }>('/account/managed/:id/status', { preHandler: origin }, async (request, reply) => {
      const key = cookie(request);
      if (!key) return failure(reply, 401, 'sign_in_required');
      const [value] = body(request, 'status') ?? [];
      if (value !== 'enabled' && value !== 'disabled') return failure(reply, 400, 'invalid_status');
      const result = await transaction(pool, async (db) => {
        const permission = await db.query<{ id: string; enabled: boolean; security_epoch: number; actor_id: string }>(`
          SELECT target.id, target.enabled, target.security_epoch, actor.id AS actor_id
          FROM web_sessions s JOIN accounts actor ON actor.id = s.account_id
          JOIN acceptance_account_operators p ON p.operator_id = actor.id AND p.account_id = $2
          JOIN accounts target ON target.id = p.account_id
          WHERE s.token_digest = $1 AND s.expires_at > now() AND actor.enabled AND actor.security_epoch = s.account_epoch
          FOR UPDATE OF actor, target`, [key, request.params.id]);
        const allowed = permission.rows[0];
        if (!allowed) return undefined;
        const stillSignedIn = await db.query('SELECT 1 FROM web_sessions WHERE token_digest = $1 AND expires_at > now()', [key]);
        if (!stillSignedIn.rowCount) return undefined;
        const { actor_id: actor, ...account } = allowed;
        return applyAccountEnabled(db, account, value === 'enabled', actor);
      });
      return result ? { enabled: result.enabled, changed: result.changed } : failure(reply, 403, 'account_not_managed');
    });
  }
}
