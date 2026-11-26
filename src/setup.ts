import { randomBytes, randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { digest } from './browser-cookie.js';
import { PasswordRejected, passwordHash, verifyAccountPassword } from './credentials.js';
import { audit, getLogin, getSetting, insertAccount, lockInstanceAdministration, rateAllowed, setSetting, transaction } from './database.js';
import type { Queryable } from './database.js';
import { mailAddress, messages, smtpInput } from './mail.js';
import type { Mailer } from './mail.js';
import { failure, fields } from './web-session.js';
import type { WebSessions } from './web-session.js';

type SetupLink = { digest: string; expires: number };
type PendingMail = { sealed: string; code: string; expires: number; attempts: number; actor: string; to: string };
const linkSeconds = 3_600;

// The instance owner opens this link once to create the first administrator and choose
// how the instance sends mail. Print it only on the operator's terminal.
export async function issueSetupLink(pool: Pool, issuer: string) {
  const token = randomBytes(32).toString('base64url');
  await transaction(pool, async (db) => {
    await lockInstanceAdministration(db);
    if (await getSetting<boolean>(db, 'initialized')) throw new Error('This instance is already initialized.');
    await setSetting(db, 'setup_link', { digest: digest(`setup:${token}`), expires: Date.now() + linkSeconds * 1_000 } satisfies SetupLink);
  });
  return { link: `${new URL(issuer).origin}/setup#${token}`, expiresInSeconds: linkSeconds };
}

const mailFields = ['host', 'port', 'security', 'username', 'password', 'from'] as const;

// Activates outgoing mail only after the administrator confirms receipt of the test message.
export async function beginMailTest(db: Queryable, mailer: Mailer, values: string[], actor: string, to: string) {
  const settings = smtpInput(Object.fromEntries(mailFields.map((name, index) => [name, values[index] ?? ''])));
  const code = String(randomInt(1_000_000)).padStart(6, '0');
  try { await mailer.try(settings, to, messages.test(code)); }
  catch { throw new Error('mail_test_failed'); }
  await setSetting(db, 'smtp_pending', { sealed: mailer.seal(settings), code: digest(`mail-test:${code}`),
    expires: Date.now() + 900_000, attempts: 0, actor, to } satisfies PendingMail);
}

export async function confirmMailTest(pool: Pool, mailer: Mailer, code: string, actor: string) {
  return transaction(pool, async (db) => {
    await db.query("SELECT 1 FROM instance_settings WHERE key = 'smtp_pending' FOR UPDATE");
    const pending = await getSetting<PendingMail>(db, 'smtp_pending');
    if (!pending || pending.actor !== actor || pending.expires < Date.now() || pending.attempts >= 5) return false;
    if (pending.code !== digest(`mail-test:${code}`)) {
      await setSetting(db, 'smtp_pending', { ...pending, attempts: pending.attempts + 1 });
      return false;
    }
    await mailer.save(db, mailer.open(pending.sealed));
    await setSetting(db, 'smtp_pending', undefined);
    // Receiving the test message also proves the administrator's address.
    await db.query('UPDATE accounts SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1 AND email = $2', [actor, pending.to]);
    await audit(db, 'instance.mail_configured', 'smtp', actor);
    return true;
  });
}

export { mailFields };

async function validSetupLink(db: Queryable, token: string | undefined) {
  if (!token) return false;
  const link = await getSetting<SetupLink>(db, 'setup_link');
  return Boolean(link && link.expires >= Date.now() && link.digest === digest(`setup:${token}`) &&
    !await getSetting<boolean>(db, 'initialized'));
}

export function registerSetup(app: FastifyInstance, pool: Pool, web: WebSessions, mailer: Mailer, backupHash: string) {
  const guard = { preHandler: web.origin };

  async function permitted(request: FastifyRequest, reply: FastifyReply, token: string | undefined) {
    if (!await rateAllowed(pool, [[`setup:source:${request.ip}`, 30]])) { await failure(reply, 429, 'try_later'); return false; }
    if (!await validSetupLink(pool, token)) { await failure(reply, 403, 'setup_link_invalid'); return false; }
    return true;
  }
  const owner = async () => (await pool.query<{ id: string; email: string }>(
    "SELECT id, email FROM accounts WHERE instance_role = 'owner' ORDER BY created_at LIMIT 1")).rows[0];

  app.post('/setup/state', guard, async (request, reply) => {
    if (!await permitted(request, reply, fields(request, 'token')?.[0])) return reply;
    const current = await owner();
    return { step: current ? 'mail' : 'owner', owner: current?.email, mail: (await mailer.status()).source };
  });

  app.post('/setup/owner', guard, async (request, reply) => {
    const [token, address, password] = fields(request, 'token', 'email', 'password') ?? [];
    if (!await permitted(request, reply, token)) return reply;
    let email: string;
    try { email = mailAddress(address ?? ''); }
    catch { return failure(reply, 400, 'invalid_email'); }
    const existing = await getLogin(pool, email);
    // An address that already has an account becomes the owner only with that account's password.
    if (!await verifyAccountPassword(password ?? '', existing?.password_hash, backupHash) && existing) return failure(reply, 401, 'invalid_credentials');
    let hash = '';
    if (!existing) {
      try { hash = await passwordHash(password ?? '', email); }
      catch (error) { return failure(reply, 400, error instanceof PasswordRejected ? error.code : 'invalid_password'); }
    }
    const session = await transaction(pool, async (db) => {
      await lockInstanceAdministration(db);
      if (!await validSetupLink(db, token)) return false;
      if ((await db.query("SELECT 1 FROM accounts WHERE instance_role = 'owner'")).rowCount) return undefined;
      const id = existing?.id ?? await insertAccount(db, email, hash, false);
      if (!id) return undefined;
      const account = (await db.query<{ security_epoch: number }>(
        `UPDATE accounts SET instance_role = 'owner' WHERE id = $1 AND enabled AND deleted_at IS NULL
           AND ($2::int IS NULL OR security_epoch = $2) RETURNING security_epoch`, [id, existing?.security_epoch ?? null])).rows[0];
      if (!account) return undefined;
      await audit(db, 'instance.admin_granted', id, id, 'owner');
      return web.issue(db, id, account.security_epoch, request);
    });
    if (session === false) return failure(reply, 403, 'setup_link_invalid');
    if (!session) return failure(reply, 409, 'owner_exists');
    web.grant(reply, session);
    return reply.code(201).send({ step: 'mail' });
  });

  app.post('/setup/mail', guard, async (request, reply) => {
    const values = fields(request, 'token', ...mailFields);
    if (!await permitted(request, reply, values?.[0])) return reply;
    const viewer = await web.viewer(request);
    const current = await owner();
    if (!viewer || !current || viewer.id !== current.id) return failure(reply, 403, 'setup_owner_required');
    try { await beginMailTest(pool, mailer, values!.slice(1), current.id, current.email); }
    catch (error) { return failure(reply, 400, error instanceof Error ? error.message : 'invalid_mail_settings'); }
    return reply.code(202).send({ sentTo: current.email });
  });

  app.post('/setup/mail/confirm', guard, async (request, reply) => {
    const [token, code] = fields(request, 'token', 'code') ?? [];
    if (!await permitted(request, reply, token)) return reply;
    const viewer = await web.viewer(request);
    const current = await owner();
    if (!viewer || !current || viewer.id !== current.id) return failure(reply, 403, 'setup_owner_required');
    return await confirmMailTest(pool, mailer, code ?? '', current.id) ? { confirmed: true } : failure(reply, 400, 'invalid_code');
  });

  // Finishing with no confirmed mail settings is the documented way to run without outgoing mail.
  app.post('/setup/finish', guard, async (request, reply) => {
    const [token] = fields(request, 'token') ?? [];
    if (!await permitted(request, reply, token)) return reply;
    const viewer = await web.viewer(request);
    const current = await owner();
    if (!viewer || !current || viewer.id !== current.id) return failure(reply, 403, 'setup_owner_required');
    const finished = await transaction(pool, async (db) => {
      await lockInstanceAdministration(db);
      if (!await validSetupLink(db, token)) return false;
      await setSetting(db, 'initialized', true);
      await setSetting(db, 'setup_link', undefined);
      await setSetting(db, 'smtp_pending', undefined);
      await audit(db, 'instance.initialized', 'instance', current.id);
      return true;
    });
    if (!finished) return failure(reply, 403, 'setup_link_invalid');
    return { initialized: true, mail: (await mailer.status()).source };
  });
}
