import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { digest, readBrowserCookie, setBrowserCookie } from './browser-cookie.js';
import {
  PasswordRejected, openClientSecret, passwordHash, passwordProblem, passwordRule, sealClientSecret, totpSecret, totpStep, verifyPassword,
} from './credentials.js';
import {
  applyAccountEnabled, audit, getLogin, getSetting, insertAccount, issueAccountLink, loginRateAllowed, rateAllowed, transaction,
} from './database.js';
import { mailAddress, messages } from './mail.js';
import type { Mailer } from './mail.js';
import type { Notifier } from './notify.js';
import type { ProtocolStore } from './protocol-store.js';
import { intentDigest } from './registration-intent.js';
import { failure, fields, requestLanguage } from './web-session.js';
import type { WebSessions } from './web-session.js';

const enrollmentCookie = '__Host-niltavi-enrollment';
const enrollmentSeconds = 900;
const resendSeconds = 60;
const codeAttempts = 5;
export const identityTestenvOrigin = 'https://identity.testenv.niltavi.com';

export function testenvSignupAllowed(issuer: URL) {
  return process.env.IDENTITY_TESTENV_UNVERIFIED_SIGNUP === 'true' && issuer.origin === identityTestenvOrigin;
}

export type RegistrationPolicy = 'open' | 'invite';
export async function registrationPolicy(pool: Pool): Promise<RegistrationPolicy> {
  return await getSetting<RegistrationPolicy>(pool, 'registration') ??
    (process.env.IDENTITY_DEPLOYMENT_PROFILE === 'hosted' ? 'invite' : 'open');
}

export type AccountServices = {
  pool: Pool; issuer: URL; web: WebSessions; mailer: Mailer; notifier: Notifier; store: ProtocolStore;
  encryptionKey: Buffer; backupHash: string; realm?: string | undefined; registrationEnabled: boolean;
};

const verificationCode = () => String(randomInt(1_000_000)).padStart(6, '0');
const codeKey = (enrollment: string, code: string) => digest(`${enrollment}\0${code}`);
const passwordFailure = (error: unknown) => error instanceof PasswordRejected ? error.code : 'invalid_password';

export async function registerBrowserAuth(app: FastifyInstance, services: AccountServices) {
  const { pool, issuer, web, mailer, notifier, store, encryptionKey, backupHash, realm, registrationEnabled } = services;
  const guard = { preHandler: web.origin };
  const testenvSignup = registrationEnabled && testenvSignupAllowed(issuer);
  const allowedDomain = process.env.IDENTITY_REGISTRATION_DOMAIN?.trim().toLowerCase() || undefined;
  if ((allowedDomain || process.env.IDENTITY_ACCEPTANCE_OPERATORS === 'true') &&
    process.env.IDENTITY_DEPLOYMENT_PROFILE !== 'acceptance') {
    throw new Error('Registration domain restrictions and acceptance operators require the acceptance profile.');
  }
  if (allowedDomain) mailAddress(`mail@${allowedDomain}`);
  const mailLanguage = requestLanguage;
  const initialized = async () => testenvSignup || Boolean(await getSetting<boolean>(pool, 'initialized'));

  app.get('/account/config', async () => {
    const [ready, codes, general, policy, applications] = await Promise.all([
      initialized(), mailer.codes(), mailer.general(), registrationPolicy(pool),
      pool.query<{ id: string; name: string; url: string }>('SELECT id, name, home_url AS url FROM applications WHERE enabled ORDER BY name, id'),
    ]);
    return {
      initialized: ready,
      registrationAvailable: registrationEnabled && ready,
      registrationMode: testenvSignup ? 'unverified-testenv' : codes ? 'verify-email' : 'immediate',
      registrationPolicy: policy, recoveryAvailable: general, passwordRule,
      registrationDomain: allowedDomain, managedAccounts: process.env.IDENTITY_ACCEPTANCE_OPERATORS === 'true',
      applications: applications.rows,
    };
  });

  app.get('/account/session', async (request, reply) => {
    const current = await web.viewer(request);
    if (current) {
      const { key: _key, sessionId: _session, ...account } = current;
      return { account };
    }
    if (web.cookieKey(request)) web.clear(reply);
    return failure(reply, 401, 'sign_in_required');
  });

  // Binds a completed registration to the authorization request that started it, so the
  // browser returns to the application without another sign-in.
  async function continuation(db: PoolClient, request: FastifyRequest, account: string, expected?: string | null) {
    const active = intentDigest(request, realm);
    if (!active || (expected !== undefined && expected !== active)) return {};
    const intent = (await db.query<{ interaction_uid: string }>(
      `UPDATE registration_intents SET account_id = $1, account_epoch = 0
        WHERE token_digest = $2 AND expires_at > now() AND account_id IS NULL RETURNING interaction_uid`, [account, active])).rows[0];
    return intent ? { continueTo: '/interaction/' + intent.interaction_uid + '/registered' } : {};
  }

  app.post('/account/register', guard, async (request, reply) => {
    if (!registrationEnabled || !await initialized()) return failure(reply, 503, 'registration_unavailable');
    const submitted = fields(request, 'email', 'password') ?? fields(request, 'email', 'password', 'invitation');
    let email: string;
    try { email = mailAddress(submitted?.[0] ?? ''); }
    catch { return failure(reply, 400, 'invalid_email'); }
    if (allowedDomain && email.split('@')[1] !== allowedDomain) return failure(reply, 400, 'registration_domain');
    if (!await loginRateAllowed(pool, request.ip, email, 'register', 5)) return failure(reply, 429, 'try_later');
    if (!testenvSignup && await registrationPolicy(pool) === 'invite') {
      const invitation = submitted?.[2];
      const invited = invitation && /^[\w-]{43}$/.test(invitation) && (await pool.query(
        `SELECT 1 FROM invitations WHERE token_digest = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
        [digest(`invite:${invitation}`), email])).rowCount;
      if (!invited) return failure(reply, 403, 'invitation_required');
    }
    let hash: string;
    try { hash = await passwordHash(submitted?.[1] ?? '', email); }
    catch (error) { return failure(reply, 400, passwordFailure(error)); }
    if (testenvSignup || !await mailer.codes()) {
      // Without outgoing mail the address cannot be verified, so the account starts unverified.
      const created = await transaction(pool, async (db) => {
        const id = await insertAccount(db, email, hash, false);
        if (!id) return undefined;
        await audit(db, testenvSignup ? 'account.testenv_registered' : 'account.registered', id, id);
        return { token: await web.issue(db, id, 0, request), body: { created: true, emailVerified: false, ...await continuation(db, request, id) } };
      });
      if (!created) return failure(reply, 409, 'email_in_use');
      web.grant(reply, created.token);
      return reply.code(201).send(created.body);
    }
    const enrollment = randomBytes(32).toString('base64url');
    const code = verificationCode();
    await pool.query('DELETE FROM email_registrations WHERE expires_at <= now()');
    await pool.query(`INSERT INTO email_registrations
      (token_digest, email, expires_at, enrollment_digest, password_hash, next_resend_at, intent_digest)
      VALUES ($1, $2, now() + $3 * interval '1 second', $4, $5, now() + $6 * interval '1 second',
        (SELECT token_digest FROM registration_intents WHERE token_digest = $7 AND expires_at > now() AND account_id IS NULL))`,
    [codeKey(enrollment, code), email, enrollmentSeconds, web.keyFor(enrollment), hash, resendSeconds, intentDigest(request, realm) ?? null]);
    // Both outcomes send one message after the response, so neither the reply nor its timing reveals an existing account.
    const language = mailLanguage(request);
    mailer.later(async () => {
      if (await getLogin(pool, email)) {
        if (await mailer.general()) await mailer.send(email, messages.existing(issuer.origin, language));
      } else await mailer.sendCode(email, code, language);
    });
    setBrowserCookie(reply, enrollmentCookie, enrollment, enrollmentSeconds);
    return reply.code(202).send({ accepted: true });
  });

  app.get('/account/enrollment', async (request, reply) => {
    const enrollment = readBrowserCookie(request, enrollmentCookie);
    if (!enrollment) return failure(reply, 404, 'enrollment_expired');
    const pending = (await pool.query<{ email: string; expiresAt: Date }>(
      'SELECT email, expires_at AS "expiresAt" FROM email_registrations WHERE enrollment_digest = $1 AND expires_at > now()',
      [web.keyFor(enrollment)])).rows[0];
    return pending ?? failure(reply, 404, 'enrollment_expired');
  });

  app.post('/account/resend', guard, async (request, reply) => {
    if (!await mailer.codes()) return failure(reply, 503, 'registration_unavailable');
    if (!fields(request)) return failure(reply, 400, 'unexpected_body');
    const enrollment = readBrowserCookie(request, enrollmentCookie);
    if (!enrollment) return failure(reply, 404, 'enrollment_expired');
    const key = web.keyFor(enrollment);
    const current = (await pool.query<{ email: string }>(
      'SELECT email FROM email_registrations WHERE enrollment_digest = $1 AND expires_at > now()', [key])).rows[0];
    if (!current) return failure(reply, 404, 'enrollment_expired');
    const { email } = current;
    if (!await loginRateAllowed(pool, request.ip, email, 'register', 5)) return failure(reply, 429, 'try_later');
    const code = verificationCode();
    const changed = await pool.query(
      `UPDATE email_registrations SET token_digest = $1, attempts = 0, expires_at = now() + $2 * interval '1 second',
          next_resend_at = now() + $4 * interval '1 second'
        WHERE enrollment_digest = $3 AND expires_at > now() AND next_resend_at <= now()`,
      [codeKey(enrollment, code), enrollmentSeconds, key, resendSeconds]);
    if (!changed.rowCount) return failure(reply.header('retry-after', String(resendSeconds)), 429, 'resend_wait');
    const language = mailLanguage(request);
    mailer.later(async () => { if (!await getLogin(pool, email)) await mailer.sendCode(email, code, language); });
    setBrowserCookie(reply, enrollmentCookie, enrollment, enrollmentSeconds);
    return reply.code(202).send({ accepted: true });
  });

  app.post('/account/verify', guard, async (request, reply) => {
    const submitted = fields(request, 'email', 'code');
    let email: string;
    try { email = mailAddress(submitted?.[0] ?? ''); }
    catch { return failure(reply, 400, 'invalid_email'); }
    const [, code] = submitted ?? [];
    const enrollment = readBrowserCookie(request, enrollmentCookie);
    if (!enrollment || !code || !/^\d{6}$/.test(code)) return failure(reply, 400, 'invalid_code');
    if (!await loginRateAllowed(pool, request.ip, email, 'verify', 12) ||
      !await rateAllowed(pool, [[`verify-day:address:${email}`, 30, 86_400]])) return failure(reply, 429, 'try_later');
    const created = await transaction(pool, async (db) => {
      const attempt = (await db.query<{ password_hash: string; intent_digest: string | null }>(
        `DELETE FROM email_registrations WHERE email = $1 AND token_digest = $2 AND enrollment_digest = $3
          AND expires_at > now() AND password_hash IS NOT NULL AND attempts < $4 RETURNING password_hash, intent_digest`,
        [email, codeKey(enrollment, code), web.keyFor(enrollment), codeAttempts])).rows[0];
      if (!attempt) return undefined;
      const id = await insertAccount(db, email, attempt.password_hash, true);
      if (!id) return undefined;
      await audit(db, 'account.email_registered', id, id);
      return { token: await web.issue(db, id, 0, request), body: { created: true, ...await continuation(db, request, id, attempt.intent_digest) } };
    });
    if (!created) {
      // A code guessed wrong five times is spent, so a six-digit code cannot be brute-forced.
      await pool.query('UPDATE email_registrations SET attempts = attempts + 1 WHERE enrollment_digest = $1', [web.keyFor(enrollment)]);
      return failure(reply, 400, 'invalid_code');
    }
    setBrowserCookie(reply, enrollmentCookie, '', 0);
    web.grant(reply, created.token);
    return reply.code(201).send(created.body);
  });

  app.post('/account/login', guard, async (request, reply) => {
    const submitted = fields(request, 'email', 'password');
    let email: string;
    try { email = mailAddress(submitted?.[0] ?? ''); }
    catch { return failure(reply, 400, 'invalid_email'); }
    if (!await loginRateAllowed(pool, request.ip, email)) return failure(reply, 429, 'try_later');
    const account = await getLogin(pool, email);
    const authentic = await verifyPassword(submitted?.[1] ?? '', account?.password_hash ?? backupHash);
    if (!account?.enabled || !authentic) {
      await audit(pool, 'account.sign_in_failed', account?.id ?? 'unknown', account?.id);
      return failure(reply, 401, 'invalid_credentials');
    }
    const token = await transaction(pool, async (db) => {
      const live = await db.query('SELECT 1 FROM accounts WHERE id = $1 AND enabled AND security_epoch = $2 FOR UPDATE',
        [account.id, account.security_epoch]);
      if (!live.rowCount) return undefined;
      await audit(db, 'account.signed_in', account.id, account.id);
      return web.issue(db, account.id, account.security_epoch, request);
    });
    if (!token) return failure(reply, 401, 'invalid_credentials');
    web.grant(reply, token);
    return reply.code(204).send();
  });

  app.post('/account/logout', guard, async (request, reply) => {
    const key = web.cookieKey(request);
    if (key) await pool.query('DELETE FROM web_sessions WHERE token_digest = $1', [key]);
    web.clear(reply);
    return reply.code(204).send();
  });

  // Signs the account out of every device: all Identity sessions and everything issued to applications.
  app.post('/account/end-sessions', guard, async (request, reply) => {
    const key = web.cookieKey(request);
    if (!key) return failure(reply, 401, 'sign_in_required');
    const ended = await transaction(pool, async (db) => {
      const locked = await db.query<{ id: string }>(`SELECT a.id FROM web_sessions s JOIN accounts a ON a.id = s.account_id
        WHERE s.token_digest = $1 AND s.expires_at > now() AND a.enabled AND a.security_epoch = s.account_epoch FOR UPDATE OF a`, [key]);
      const account = locked.rows[0];
      if (!account) return undefined;
      const current = await db.query('SELECT 1 FROM web_sessions WHERE token_digest = $1 AND expires_at > now()', [key]);
      if (!current.rowCount) return undefined;
      await db.query('UPDATE accounts SET security_epoch = security_epoch + 1 WHERE id = $1', [account.id]);
      await db.query('DELETE FROM web_sessions WHERE account_id = $1', [account.id]);
      await db.query('DELETE FROM oidc_records WHERE account_id = $1', [account.id]);
      await audit(db, 'account.sessions_ended', account.id, account.id);
      return account.id;
    });
    web.clear(reply);
    if (!ended) return failure(reply, 401, 'sign_in_required');
    notifier.account(ended);
    return reply.code(204).send();
  });

  app.post('/account/profile', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    const [name, locale] = fields(request, 'name', 'locale') ?? fields(request, 'name') ?? [];
    if (name === undefined || [...name.trim()].length > 80 ||
        (locale !== undefined && !['', 'en', 'zh-CN'].includes(locale))) return failure(reply, 400, 'invalid_profile');
    await pool.query(`UPDATE accounts SET display_name = $2, locale = CASE WHEN $3 THEN $4 ELSE locale END WHERE id = $1`,
      [viewer.id, name.trim() || null, locale !== undefined, locale || null]);
    return reply.code(204).send();
  });

  app.post('/account/preferences', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    const [locale] = fields(request, 'locale') ?? [];
    if (locale === undefined || !['', 'en', 'zh-CN'].includes(locale)) return failure(reply, 400, 'invalid_request');
    await pool.query('UPDATE accounts SET locale = $2 WHERE id = $1', [viewer.id, locale || null]);
    return reply.code(204).send();
  });

  app.get('/account/applications', async (request, reply) => {
    const viewer = await web.viewer(request);
    return viewer ? { applications: await store.applications(viewer.id) } : failure(reply, 401, 'sign_in_required');
  });

  app.post<{ Params: { id: string } }>('/account/applications/:id/revoke', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    const [password] = fields(request, 'password') ?? [];
    if (!password) return failure(reply, 400, 'invalid_request');
    if (!await loginRateAllowed(pool, request.ip, viewer.email, 'revoke-app', 5)) return failure(reply, 429, 'try_later');
    const account = await getLogin(pool, viewer.email);
    const authentic = await verifyPassword(password, account?.password_hash ?? backupHash);
    if (!authentic || !account?.enabled || account.id !== viewer.id) return failure(reply, 403, 'incorrect_password');
    const client = request.params.id;
    const result = await transaction(pool, async (db) => {
      const current = await db.query(`SELECT 1 FROM accounts
        WHERE id = $1 AND enabled AND security_epoch = $2 FOR UPDATE`, [viewer.id, account.security_epoch]);
      const session = current.rowCount && await db.query(`SELECT 1 FROM web_sessions
        WHERE token_digest = $1 AND account_id = $2 AND account_epoch = $3 AND expires_at > clock_timestamp() FOR UPDATE`,
        [viewer.key, viewer.id, account.security_epoch]);
      if (!session || !session.rowCount) return { signedIn: false } as const;
      const targets = await store.revokeApplication(db, viewer.id, client);
      if (targets) await audit(db, 'account.application_revoked', client, viewer.id);
      return { signedIn: true, targets } as const;
    });
    if (!result.signedIn) return failure(reply, 401, 'sign_in_required');
    if (result.targets) notifier.session(viewer.id, result.targets);
    return reply.code(204).send();
  });

  app.get('/account/sessions', async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    const [browser, central, names] = await Promise.all([
      pool.query<{ id: string; createdAt: Date; expiresAt: Date; userAgent: string | null }>(
        `SELECT s.id, s.created_at AS "createdAt", s.expires_at AS "expiresAt", s.user_agent AS "userAgent"
         FROM web_sessions s JOIN accounts a ON a.id = s.account_id
         WHERE s.account_id = $1 AND s.expires_at > now() AND s.account_epoch = a.security_epoch ORDER BY s.created_at DESC`, [viewer.id]),
      store.sessions(viewer.id),
      pool.query<{ id: string; name: string }>('SELECT id, name FROM applications'),
    ]);
    const name = new Map(names.rows.map((row) => [row.id, row.name]));
    return { sessions: [
      ...browser.rows.map((row) => ({ kind: 'account', ...row, current: row.id === viewer.sessionId, applications: [] })),
      ...central.map((session) => ({ kind: 'applications', id: session.key, createdAt: session.signedInAt, expiresAt: session.expiresAt,
        userAgent: null, current: false, applications: session.apps.map(({ id }) => name.get(id) ?? id) })),
    ] };
  });

  app.post('/account/sessions/revoke', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    const [kind, id] = fields(request, 'kind', 'id') ?? [];
    if (!id || (kind !== 'account' && kind !== 'applications')) return failure(reply, 400, 'invalid_session');
    const targets = await transaction(pool, async (db) => {
      // Serialize with password reset and account-wide revocation, which also touch these rows.
      const live = await db.query(`SELECT 1 FROM accounts a JOIN web_sessions s ON s.account_id = a.id
        WHERE a.id = $1 AND a.enabled AND s.account_epoch = a.security_epoch
          AND s.token_digest = $2 AND s.expires_at > now() FOR UPDATE OF a`, [viewer.id, viewer.key]);
      if (!live.rowCount) return undefined;
      const affected = kind === 'applications' ? await store.endSession(db, viewer.id, id) : [];
      if (!affected) return undefined;
      if (kind === 'account') {
        const removed = await db.query('DELETE FROM web_sessions WHERE id = $1 AND account_id = $2', [id, viewer.id]);
        if (!removed.rowCount) return undefined;
      }
      await audit(db, 'account.session_revoked', viewer.id, viewer.id, kind);
      return affected;
    });
    if (!targets) return failure(reply, 404, 'session_not_found');
    if (kind === 'account' && id === viewer.sessionId) web.clear(reply);
    notifier.session(viewer.id, targets);
    return reply.code(204).send();
  });

  // The reply and its timing are the same whether or not the address has an account.
  app.post('/account/recover', guard, async (request, reply) => {
    let email: string;
    try { email = mailAddress(fields(request, 'email')?.[0] ?? ''); }
    catch { return failure(reply, 400, 'invalid_email'); }
    if (!await rateAllowed(pool, [[`recover:address:${email}`, 3, 900], [`recover:source:${request.ip}`, 20]])) {
      return failure(reply, 429, 'try_later');
    }
    mailer.later(async () => {
      if (!await mailer.general()) return;
      // An unverified address proves nothing about who owns the account, so it gets no link.
      const account = (await pool.query<{ id: string; locale: 'en' | 'zh-CN' | null }>(
        'SELECT id, locale FROM accounts WHERE email = $1 AND enabled AND email_verified_at IS NOT NULL', [email])).rows[0];
      if (!account) return;
      const language = mailLanguage(request, account.locale);
      const link = issuer.origin + (language === 'zh' ? '/zh' : '') + '/reset#';
      const token = await transaction(pool, async (db) => {
        await audit(db, 'account.recovery_requested', account.id, account.id);
        return issueAccountLink(db, account.id, email, 'reset');
      });
      await mailer.send(email, messages.reset(link + token, language));
    });
    return reply.code(202).send({ accepted: true });
  });

  app.post('/account/reset', guard, async (request, reply) => {
    const [token, password] = fields(request, 'token', 'password') ?? [];
    if (!token || !/^[\w-]{43}$/.test(token)) return failure(reply, 400, 'invalid_link');
    if (!await rateAllowed(pool, [[`reset:source:${request.ip}`, 20]])) return failure(reply, 429, 'try_later');
    const problem = passwordProblem(password ?? '');
    if (problem) return failure(reply, 400, problem);
    let outcome;
    try {
      outcome = await transaction(pool, async (db) => {
        // Deleting the row is what consumes the link: a replay or a concurrent submit finds nothing.
        const link = (await db.query<{ account_id: string; email: string }>(
          `DELETE FROM account_links WHERE token_digest = $1 AND purpose = 'reset' AND expires_at > now() RETURNING account_id, email`,
          [digest(`reset:${token}`)])).rows[0];
        if (!link) return undefined;
        const hash = await passwordHash(password ?? '', link.email);
        const account = (await db.query<{ id: string; security_epoch: number }>(
          `UPDATE accounts SET password_hash = $2, security_epoch = security_epoch + 1
            WHERE id = $1 AND email = $3 AND enabled RETURNING id, security_epoch`, [link.account_id, hash, link.email])).rows[0];
        if (!account) return undefined;
        await db.query('DELETE FROM oidc_records WHERE account_id = $1', [account.id]);
        await db.query('DELETE FROM web_sessions WHERE account_id = $1', [account.id]);
        await audit(db, 'account.password_reset', account.id, account.id);
        return { id: account.id, token: await web.issue(db, account.id, account.security_epoch, request) };
      });
    } catch (error) {
      if (error instanceof PasswordRejected) return failure(reply, 400, error.code);
      throw error;
    }
    if (!outcome) return failure(reply, 400, 'invalid_link');
    notifier.account(outcome.id);
    web.grant(reply, outcome.token);
    // Agent tokens survive a reset on purpose. The page lists them so the user can revoke any of them.
    return { reset: true, agentTokens: await agentTokens(outcome.id) };
  });

  app.post('/account/email/verification', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    if (!fields(request)) return failure(reply, 400, 'unexpected_body');
    if (viewer.emailVerified) return failure(reply, 409, 'already_verified');
    if (!await mailer.general()) return failure(reply, 503, 'delivery_unavailable');
    if (!await rateAllowed(pool, [[`verify-link:${viewer.id}`, 3, 900], [`verify-link:source:${request.ip}`, 20]])) {
      return failure(reply, 429, 'try_later');
    }
    const token = await issueAccountLink(pool, viewer.id, viewer.email, 'verify');
    const language = mailLanguage(request, viewer.locale);
    const link = issuer.origin + (language === 'zh' ? '/zh' : '') + '/verify-email#' + token;
    mailer.later(() => mailer.send(viewer.email, messages.verify(link, language)));
    return reply.code(202).send({ accepted: true });
  });

  app.post('/account/email/confirm', guard, async (request, reply) => {
    const [token] = fields(request, 'token') ?? [];
    if (!token || !/^[\w-]{43}$/.test(token)) return failure(reply, 400, 'invalid_link');
    if (!await rateAllowed(pool, [[`confirm:source:${request.ip}`, 20]])) return failure(reply, 429, 'try_later');
    const confirmed = await transaction(pool, async (db) => {
      const link = (await db.query<{ account_id: string; email: string }>(
        `DELETE FROM account_links WHERE token_digest = $1 AND purpose = 'verify' AND expires_at > now() RETURNING account_id, email`,
        [digest(`verify:${token}`)])).rows[0];
      if (!link) return false;
      const account = await db.query('UPDATE accounts SET email_verified_at = now() WHERE id = $1 AND email = $2 AND enabled',
        [link.account_id, link.email]);
      if (!account.rowCount) return false;
      await audit(db, 'account.email_verified', link.account_id, link.account_id);
      return true;
    });
    return confirmed ? { verified: true } : failure(reply, 400, 'invalid_link');
  });

  async function agentTokens(account: string) {
    return (await pool.query(
      `SELECT t.id, t.name, t.hint, t.app_id AS "appId", p.name AS "appName", t.org_id AS "orgId", o.name AS "orgName",
              o.personal_account_id IS NOT NULL AS personal, t.created_at AS "createdAt", t.expires_at AS "expiresAt",
              t.last_used_at AS "lastUsedAt"
       FROM agent_tokens t JOIN applications p ON p.id = t.app_id JOIN orgs o ON o.id = t.org_id
       WHERE t.account_id = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
       ORDER BY t.created_at DESC`, [account])).rows;
  }

  app.get('/account/tokens', async (request, reply) => {
    const viewer = await web.viewer(request);
    return viewer ? { tokens: await agentTokens(viewer.id) } : failure(reply, 401, 'sign_in_required');
  });

  app.post('/account/tokens', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    const [label, appId, org, days] = fields(request, 'name', 'app', 'org', 'days') ?? [];
    const name = (label ?? '').trim();
    const lifetime = days === '' ? null : Number(days);
    if (!name || [...name].length > 80 || !appId || !org ||
      (lifetime !== null && (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > 366))) return failure(reply, 400, 'invalid_token_request');
    if (!await rateAllowed(pool, [[`token:create:${viewer.id}`, 20, 3_600]])) return failure(reply, 429, 'try_later');
    const token = 'nvt_' + randomBytes(32).toString('base64url');
    const id = randomUUID();
    const created = await transaction(pool, async (db) => {
      const allowed = await db.query(`SELECT 1 FROM applications p, memberships m
        WHERE p.id = $1 AND p.enabled AND m.org_id = $2 AND m.account_id = $3`, [appId, org, viewer.id]);
      if (!allowed.rowCount) return false;
      await db.query(`INSERT INTO agent_tokens (id, token_digest, account_id, app_id, org_id, name, hint, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, now() + $8 * interval '1 day')`,
      [id, digest(token), viewer.id, appId, org, name, token.slice(-4), lifetime]);
      await audit(db, 'agent_token.issued', id, viewer.id, appId);
      return true;
    });
    if (!created) return failure(reply, 400, 'invalid_token_request');
    // The token value leaves the server here and nowhere else.
    return reply.code(201).send({ id, token });
  });

  app.post<{ Params: { id: string } }>('/account/tokens/:id/revoke', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    if (!fields(request)) return failure(reply, 400, 'unexpected_body');
    const revoked = await transaction(pool, async (db) => {
      const changed = await db.query('UPDATE agent_tokens SET revoked_at = now() WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL',
        [request.params.id, viewer.id]);
      if (changed.rowCount) await audit(db, 'agent_token.revoked', request.params.id, viewer.id);
      return Boolean(changed.rowCount);
    });
    return revoked ? reply.code(204).send() : failure(reply, 404, 'token_not_found');
  });

  const sealLabel = (account: string) => `totp:${account}`;
  async function secondFactor(account: string, code: string | undefined, confirmed: boolean) {
    if (!code || !await rateAllowed(pool, [[`totp:${account}`, 5]])) return false;
    return transaction(pool, async (db) => {
      const row = (await db.query<{ totp_secret: string | null; totp_last_step: string | null; confirmed: boolean }>(
        'SELECT totp_secret, totp_last_step, totp_confirmed_at IS NOT NULL AS confirmed FROM accounts WHERE id = $1 FOR UPDATE', [account])).rows[0];
      if (!row?.totp_secret || row.confirmed !== confirmed) return false;
      const step = totpStep(openClientSecret(sealLabel(account), row.totp_secret, encryptionKey), code, Number(row.totp_last_step ?? -1));
      if (step === undefined) return false;
      // Remembering the step makes each code single-use.
      await db.query('UPDATE accounts SET totp_last_step = $2, totp_confirmed_at = coalesce(totp_confirmed_at, now()) WHERE id = $1', [account, step]);
      return true;
    });
  }

  app.post('/account/second-factor/setup', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    if (!fields(request)) return failure(reply, 400, 'unexpected_body');
    if (viewer.secondFactorEnabled) return failure(reply, 409, 'second_factor_enabled');
    const secret = totpSecret();
    await pool.query('UPDATE accounts SET totp_secret = $2, totp_last_step = NULL WHERE id = $1 AND totp_confirmed_at IS NULL',
      [viewer.id, sealClientSecret(sealLabel(viewer.id), secret, encryptionKey)]);
    const label = encodeURIComponent(`Niltavi Identity:${viewer.email}`);
    return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=Niltavi%20Identity&algorithm=SHA1&digits=6&period=30` };
  });

  app.post('/account/second-factor/enable', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    if (!await secondFactor(viewer.id, fields(request, 'code')?.[0], false)) return failure(reply, 400, 'invalid_code');
    await pool.query('UPDATE web_sessions SET second_factor_at = now() WHERE token_digest = $1', [viewer.key]);
    await audit(pool, 'account.second_factor_enabled', viewer.id, viewer.id);
    return reply.code(204).send();
  });

  app.post('/account/second-factor/verify', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    if (!await secondFactor(viewer.id, fields(request, 'code')?.[0], true)) return failure(reply, 400, 'invalid_code');
    await pool.query('UPDATE web_sessions SET second_factor_at = now() WHERE token_digest = $1', [viewer.key]);
    return reply.code(204).send();
  });

  app.post('/account/second-factor/disable', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    if (!await secondFactor(viewer.id, fields(request, 'code')?.[0], true)) return failure(reply, 400, 'invalid_code');
    await pool.query('UPDATE accounts SET totp_secret = NULL, totp_confirmed_at = NULL, totp_last_step = NULL WHERE id = $1', [viewer.id]);
    await pool.query('UPDATE web_sessions SET second_factor_at = NULL WHERE account_id = $1', [viewer.id]);
    await audit(pool, 'account.second_factor_removed', viewer.id, viewer.id);
    return reply.code(204).send();
  });

  // Deleting an account is an administrator action. The user can only ask for it.
  app.post('/account/deletion-request', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    const [state] = fields(request, 'state') ?? [];
    if (state !== 'requested' && state !== 'withdrawn') return failure(reply, 400, 'invalid_state');
    const changed = await pool.query(
      `UPDATE accounts SET deletion_requested_at = CASE WHEN $2 THEN now() END
        WHERE id = $1 AND (deletion_requested_at IS NULL) = $2`, [viewer.id, state === 'requested']);
    if (changed.rowCount) await audit(pool, state === 'requested' ? 'account.deletion_requested' : 'account.deletion_withdrawn', viewer.id, viewer.id);
    return reply.code(204).send();
  });

  if (process.env.IDENTITY_ACCEPTANCE_OPERATORS === 'true') {
    app.get('/account/managed', async (request, reply) => {
      const current = await web.viewer(request);
      if (!current) return failure(reply, 401, 'sign_in_required');
      const result = await pool.query(`SELECT a.id, a.email, a.enabled FROM acceptance_account_operators p
        JOIN accounts a ON a.id = p.account_id WHERE p.operator_id = $1 ORDER BY a.email`, [current.id]);
      return { accounts: result.rows };
    });

    app.post<{ Params: { id: string } }>('/account/managed/:id/status', guard, async (request, reply) => {
      const key = web.cookieKey(request);
      if (!key) return failure(reply, 401, 'sign_in_required');
      const [value] = fields(request, 'status') ?? [];
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
      if (result?.changed && !result.enabled) notifier.account(result.id);
      return result ? { enabled: result.enabled, changed: result.changed } : failure(reply, 403, 'account_not_managed');
    });
  }
}
