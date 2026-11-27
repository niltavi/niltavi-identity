import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { digest, readBrowserCookie, setBrowserCookie } from './browser-cookie.js';
import {
  PasswordRejected, openClientSecret, passwordHash, passwordProblem, passwordRule, sealClientSecret, totpSecret, totpStep, verifyAccountPassword,
} from './credentials.js';
import {
  applyAccountEnabled, audit, getLogin, getSetting, issueAccountLink, loginRateAllowed, rateAllowed, transaction,
} from './database.js';
import { mailAddress, messages } from './mail.js';
import type { Mailer } from './mail.js';
import type { Notifier } from './notify.js';
import type { ProtocolStore } from './protocol-store.js';
import { beginRegistrationIntent, intentDigest } from './registration-intent.js';
import { registerNewAccount, registrationPolicy, registrationRefusal } from './registration.js';
import { failure, fields, requestLanguage } from './web-session.js';
import type { WebSessions } from './web-session.js';

const enrollmentCookie = '__Host-niltavi-enrollment';
const enrollmentSeconds = 900;
const resendSeconds = 60;
const codeAttempts = 5;
export type AccountServices = {
  pool: Pool; issuer: URL; web: WebSessions; mailer: Mailer; notifier: Notifier; store: ProtocolStore;
  encryptionKey: Buffer; backupHash: string; realm?: string | undefined; registrationEnabled: boolean;
};

const verificationCode = () => String(randomInt(1_000_000)).padStart(6, '0');
const codeKey = (enrollment: string, code: string) => digest(`${enrollment}\0${code}`);
const invitationKey = (invitation?: string) => invitation && /^[\w-]{43}$/.test(invitation) ? digest(`invite:${invitation}`) : null;
const passwordFailure = (error: unknown) => error instanceof PasswordRejected ? error.code : 'invalid_password';

export async function registerBrowserAuth(app: FastifyInstance, services: AccountServices) {
  const { pool, issuer, web, mailer, notifier, store, encryptionKey, backupHash, realm, registrationEnabled } = services;
  const guard = { preHandler: web.origin };
  const allowedDomain = process.env.IDENTITY_REGISTRATION_DOMAIN?.trim().toLowerCase() || undefined;
  if ((allowedDomain || process.env.IDENTITY_ACCEPTANCE_OPERATORS === 'true') &&
    process.env.IDENTITY_DEPLOYMENT_PROFILE !== 'acceptance') {
    throw new Error('Registration domain restrictions and acceptance operators require the acceptance profile.');
  }
  if (allowedDomain) mailAddress(`mail@${allowedDomain}`);
  const enrollmentCookieFor = (uid?: string) => uid ? `${enrollmentCookie}-${uid}` : enrollmentCookie;
  const enrollmentKey = (token: string, uid?: string) => web.keyFor(uid ? token + '\0' + uid : token);
  app.get('/account/config', async () => {
    const [ready, codes, general, policy, applications] = await Promise.all([
      getSetting<boolean>(pool, 'initialized'), mailer.codes(), mailer.general(), registrationPolicy(pool),
      pool.query<{ id: string; name: string; url: string }>('SELECT id, name, home_url AS url FROM applications WHERE enabled ORDER BY name, id'),
    ]);
    return {
      initialized: Boolean(ready),
      registrationAvailable: registrationEnabled && policy !== 'closed',
      registrationMode: codes ? 'verify-email' : 'immediate',
      registrationPolicy: policy, recoveryAvailable: general, passwordRule,
      passwordlessAvailable: codes,
      registrationDomain: allowedDomain, managedAccounts: process.env.IDENTITY_ACCEPTANCE_OPERATORS === 'true',
      applications: applications.rows,
    };
  });

  app.get('/account/session', async (request, reply) => {
    const current = await web.viewer(request);
    if (current) {
      const { key: _key, sessionId: _session, ...account } = current;
      return { account: { ...account, recoveryCodesLeft: account.secondFactorEnabled ? await recoveryCodesLeft(account.id) : 0 } };
    }
    if (web.cookieKey(request)) web.clear(reply);
    return failure(reply, 401, 'sign_in_required');
  });

  // Binds a completed registration to the authorization request that started it, so the
  // browser returns to the application without another sign-in.
  async function continuation(db: PoolClient, active: string | undefined, account: string, expected?: string | null) {
    if (!active || (expected !== undefined && expected !== active)) return {};
    const intent = (await db.query<{ interaction_uid: string }>(
      `UPDATE registration_intents SET account_id = $1, account_epoch = 0
        WHERE token_digest = $2 AND expires_at > now() AND account_id IS NULL RETURNING interaction_uid`, [account, active])).rows[0];
    return intent ? { continueTo: '/interaction/' + intent.interaction_uid + '/registered' } : {};
  }

  async function registerAccount(request: FastifyRequest, reply: FastifyReply, uid?: string) {
    if (!registrationEnabled) return failure(reply, 503, 'registration_unavailable');
    const passwordless = await mailer.codes();
    const withPassword = fields(request, 'email', 'password', 'invitation') ?? fields(request, 'email', 'password');
    const withCode = passwordless ? fields(request, 'email', 'invitation') ?? fields(request, 'email') : undefined;
    let email: string;
    try { email = mailAddress((withPassword ?? withCode)?.[0] ?? ''); }
    catch { return failure(reply, 400, 'invalid_email'); }
    if (allowedDomain && email.split('@')[1] !== allowedDomain) return failure(reply, 400, 'registration_domain');
    if (!await loginRateAllowed(pool, request.ip, email, 'register', 5)) return failure(reply, 429, 'try_later');
    const invitation = withPassword?.[2] ?? withCode?.[1];
    const invitationDigest = invitationKey(invitation);
    const refused = await registrationRefusal(pool, email, invitationDigest);
    if (refused) return failure(reply, 403, refused);
    const rawPassword = withPassword?.[1];
    let hash: string | null = null;
    if (rawPassword !== undefined) {
      try { hash = await passwordHash(rawPassword, email); }
      catch (error) { return failure(reply, 400, passwordFailure(error)); }
    }
    const activeIntent = uid ? await beginRegistrationIntent(pool, reply, uid, realm, true) : intentDigest(request, realm);
    if (!passwordless) {
      const created = await transaction(pool, async (db) => {
        const account = await registerNewAccount(db, email, hash, false, invitationDigest);
        if (account.error) return { error: account.error };
        const { id } = account;
        await audit(db, 'account.registered', id, id);
        return { token: await web.issue(db, id, 0, request), body: { created: true, emailVerified: false, ...await continuation(db, activeIntent, id) } };
      });
      if (created.error) return failure(reply, created.error === 'email_in_use' ? 409 : 403, created.error);
      web.grant(reply, created.token);
      return reply.code(201).send(created.body);
    }
    const enrollment = randomBytes(32).toString('base64url');
    const code = verificationCode();
    await pool.query('DELETE FROM email_registrations WHERE expires_at <= now()');
    await pool.query(`INSERT INTO email_registrations
      (token_digest, email, expires_at, enrollment_digest, password_hash, next_resend_at, intent_digest, invitation_digest)
      VALUES ($1, $2, now() + $3 * interval '1 second', $4, $5, now() + $6 * interval '1 second',
        (SELECT token_digest FROM registration_intents WHERE token_digest = $7 AND expires_at > now() AND account_id IS NULL), $8)`,
    [codeKey(enrollment, code), email, enrollmentSeconds, enrollmentKey(enrollment, uid), hash, resendSeconds,
      activeIntent ?? null, invitationDigest]);
    mailer.later(async () => {
      if (await getLogin(pool, email)) {
        if (await mailer.general()) await mailer.send(email, messages.existing(issuer.origin, requestLanguage(request)));
      } else await mailer.sendCode(email, code);
    });
    setBrowserCookie(reply, enrollmentCookieFor(uid), enrollment, enrollmentSeconds);
    return reply.code(202).send({ accepted: true });
  }

  async function pendingEnrollment(request: FastifyRequest, reply: FastifyReply, uid?: string) {
    const enrollment = readBrowserCookie(request, enrollmentCookieFor(uid));
    if (!enrollment) return failure(reply, 404, 'enrollment_expired');
    const pending = (await pool.query<{ email: string; expiresAt: Date }>(
      'SELECT email, expires_at AS "expiresAt" FROM email_registrations WHERE enrollment_digest = $1 AND expires_at > now()',
      [enrollmentKey(enrollment, uid)])).rows[0];
    return pending ?? failure(reply, 404, 'enrollment_expired');
  }

  async function resendEnrollment(request: FastifyRequest, reply: FastifyReply, uid?: string) {
    if (!registrationEnabled || !await mailer.codes()) return failure(reply, 503, 'registration_unavailable');
    if (!fields(request)) return failure(reply, 400, 'unexpected_body');
    const enrollment = readBrowserCookie(request, enrollmentCookieFor(uid));
    if (!enrollment) return failure(reply, 404, 'enrollment_expired');
    const key = enrollmentKey(enrollment, uid);
    const current = (await pool.query<{ email: string; invitation_digest: string | null }>(
      'SELECT email, invitation_digest FROM email_registrations WHERE enrollment_digest = $1 AND expires_at > now()', [key])).rows[0];
    if (!current) return failure(reply, 404, 'enrollment_expired');
    const { email } = current;
    const refused = await registrationRefusal(pool, email, current.invitation_digest);
    if (refused) return failure(reply, 403, refused);
    if (!await loginRateAllowed(pool, request.ip, email, 'register', 5)) return failure(reply, 429, 'try_later');
    const code = verificationCode();
    const changed = await pool.query(
      `UPDATE email_registrations SET token_digest = $1, attempts = 0, expires_at = now() + $2 * interval '1 second',
          next_resend_at = now() + $4 * interval '1 second'
        WHERE enrollment_digest = $3 AND expires_at > now() AND next_resend_at <= now()`,
      [codeKey(enrollment, code), enrollmentSeconds, key, resendSeconds]);
    if (!changed.rowCount) return failure(reply.header('retry-after', String(resendSeconds)), 429, 'resend_wait');
    mailer.later(async () => { if (!await getLogin(pool, email)) await mailer.sendCode(email, code); });
    setBrowserCookie(reply, enrollmentCookieFor(uid), enrollment, enrollmentSeconds);
    return reply.code(202).send({ accepted: true });
  }

  async function verifyEnrollment(request: FastifyRequest, reply: FastifyReply, uid?: string) {
    if (!registrationEnabled) return failure(reply, 503, 'registration_unavailable');
    const submitted = fields(request, 'email', 'code');
    let email: string;
    try { email = mailAddress(submitted?.[0] ?? ''); }
    catch { return failure(reply, 400, 'invalid_email'); }
    const [, code] = submitted ?? [];
    const enrollment = readBrowserCookie(request, enrollmentCookieFor(uid));
    if (!enrollment || !code || !/^\d{6}$/.test(code)) return failure(reply, 400, 'invalid_code');
    if (!await loginRateAllowed(pool, request.ip, email, 'verify', 12) ||
      !await rateAllowed(pool, [[`verify-day:address:${email}`, 30, 86_400]])) return failure(reply, 429, 'try_later');
    const key = enrollmentKey(enrollment, uid);
    const activeIntent = intentDigest(request, realm, uid);
    const created = await transaction(pool, async (db) => {
      const attempt = (await db.query<{ password_hash: string | null; intent_digest: string | null; invitation_digest: string | null }>(
        `DELETE FROM email_registrations WHERE email = $1 AND token_digest = $2 AND enrollment_digest = $3
          AND expires_at > now() AND attempts < $4 RETURNING password_hash, intent_digest, invitation_digest`,
        [email, codeKey(enrollment, code), key, codeAttempts])).rows[0];
      if (!attempt) return undefined;
      const account = await registerNewAccount(db, email, attempt.password_hash, true, attempt.invitation_digest);
      if (account.error) return account.error === 'email_in_use' ? undefined : { error: account.error };
      const { id } = account;
      await audit(db, 'account.email_registered', id, id);
      return { token: await web.issue(db, id, 0, request), body: { created: true, ...await continuation(db, activeIntent, id, attempt.intent_digest) } };
    });
    if (!created) {
      // A code guessed wrong five times is spent, so a six-digit code cannot be brute-forced.
      await pool.query('UPDATE email_registrations SET attempts = attempts + 1 WHERE enrollment_digest = $1', [key]);
      return failure(reply, 400, 'invalid_code');
    }
    setBrowserCookie(reply, enrollmentCookieFor(uid), '', 0);
    if (created.error) return failure(reply, 403, created.error);
    web.grant(reply, created.token);
    return reply.code(201).send(created.body);
  }
  app.post('/account/register', guard, (request, reply) => registerAccount(request, reply));
  app.get('/account/enrollment', (request, reply) => pendingEnrollment(request, reply));
  app.post('/account/resend', guard, (request, reply) => resendEnrollment(request, reply));
  app.post('/account/verify', guard, (request, reply) => verifyEnrollment(request, reply));

  app.post('/account/login', guard, async (request, reply) => {
    const submitted = fields(request, 'email', 'password');
    let email: string;
    try { email = mailAddress(submitted?.[0] ?? ''); }
    catch { return failure(reply, 400, 'invalid_email'); }
    if (!await loginRateAllowed(pool, request.ip, email)) return failure(reply, 429, 'try_later');
    const account = await getLogin(pool, email);
    const authentic = await verifyAccountPassword(submitted?.[1] ?? '', account?.password_hash, backupHash);
    if (!account?.enabled || !authentic) {
      await audit(pool, 'account.sign_in_failed', account?.id ?? 'unknown', account?.id);
      return failure(reply, 401, 'invalid_credentials');
    }
    if (account.second_factor) return challengeSecondFactor(reply, account);
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

  app.post('/account/login-second-factor', guard, async (request, reply) => {
    const result = await completeSecondFactor(request, reply);
    if (!result) return reply;
    web.grant(reply, result.token);
    return reply.code(200).send({ recoveryCodesLeft: result.recoveryCodesLeft });
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

  app.post('/account/password', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    const submitted = fields(request, 'current', 'password');
    if (!submitted) return failure(reply, 400, 'unexpected_body');
    const [current, password] = submitted;
    if (!await loginRateAllowed(pool, request.ip, viewer.email, 'change-password', 5)) return failure(reply, 429, 'try_later');
    const account = await getLogin(pool, viewer.email);
    const authentic = await verifyAccountPassword(current ?? '', account?.password_hash, backupHash);
    if (!authentic || !account?.enabled || account.id !== viewer.id) return failure(reply, 403, 'incorrect_password');
    try {
      const hash = await passwordHash(password ?? '', viewer.email);
      await pool.query('UPDATE accounts SET password_hash = $1 WHERE id = $2', [hash, viewer.id]);
      await audit(pool, 'account.password_changed', viewer.id, viewer.id);
    } catch (error) {
      if (error instanceof PasswordRejected) return failure(reply, 400, error.code);
      throw error;
    }
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
    const authentic = await verifyAccountPassword(password, account?.password_hash, backupHash);
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
      const language = requestLanguage(request, account.locale);
      const link = issuer.origin + (language === 'zh' ? '/zh' : '') + '/reset#';
      const token = await transaction(pool, async (db) => {
        await audit(db, 'account.recovery_requested', account.id, account.id);
        return issueAccountLink(db, account.id, email, 'reset');
      });
      await mailer.send(email, messages.reset(link + token));
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
    const language = requestLanguage(request, viewer.locale);
    const link = issuer.origin + (language === 'zh' ? '/zh' : '') + '/verify-email#' + token;
    mailer.later(() => mailer.send(viewer.email, messages.verify(link)));
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

  const verifyCodeCookie = '__Host-niltavi-email-verify';
  const verifyCodeSeconds = 900;

  const disable2faCookie = '__Host-niltavi-disable-2fa';
  const disable2faSeconds = 900;

  app.post('/account/email/verification-code', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    if (!fields(request)) return failure(reply, 400, 'unexpected_body');
    if (viewer.emailVerified) return failure(reply, 409, 'already_verified');
    if (!await mailer.codes()) return failure(reply, 503, 'delivery_unavailable');
    if (!await rateAllowed(pool, [[`verify-code:${viewer.id}`, 3, 900], [`verify-code:source:${request.ip}`, 20]])) {
      return failure(reply, 429, 'try_later');
    }
    const enrollment = randomBytes(32).toString('base64url');
    const code = verificationCode();
    await pool.query('DELETE FROM email_verification_codes WHERE expires_at <= now()');
    await pool.query(`INSERT INTO email_verification_codes (account_id, token_digest, email, expires_at, next_resend_at)
      VALUES ($1, $2, $3, now() + $4 * interval '1 second', now() + $5 * interval '1 second')
      ON CONFLICT (account_id) DO UPDATE SET token_digest = EXCLUDED.token_digest, email = EXCLUDED.email,
        attempts = 0, expires_at = EXCLUDED.expires_at, next_resend_at = EXCLUDED.next_resend_at`,
    [viewer.id, codeKey(enrollment, code), viewer.email, verifyCodeSeconds, resendSeconds]);
    mailer.later(() => mailer.sendCode(viewer.email, code));
    setBrowserCookie(reply, verifyCodeCookie, enrollment, verifyCodeSeconds);
    return reply.code(202).send({ accepted: true, email: viewer.email });
  });

  app.post('/account/email/resend-code', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    if (!fields(request)) return failure(reply, 400, 'unexpected_body');
    if (viewer.emailVerified) return failure(reply, 409, 'already_verified');
    if (!await mailer.codes()) return failure(reply, 503, 'delivery_unavailable');
    if (!await rateAllowed(pool, [[`verify-code:${viewer.id}`, 3, 900], [`verify-code:source:${request.ip}`, 20]])) {
      return failure(reply, 429, 'try_later');
    }
    const enrollment = randomBytes(32).toString('base64url');
    const code = verificationCode();
    const changed = await pool.query(
      `UPDATE email_verification_codes SET token_digest = $1, attempts = 0,
          expires_at = now() + $2 * interval '1 second', next_resend_at = now() + $3 * interval '1 second'
        WHERE account_id = $4 AND expires_at > now() AND next_resend_at <= now()`,
      [codeKey(enrollment, code), verifyCodeSeconds, resendSeconds, viewer.id]);
    if (!changed.rowCount) return failure(reply.header('retry-after', String(resendSeconds)), 429, 'resend_wait');
    mailer.later(() => mailer.sendCode(viewer.email, code));
    setBrowserCookie(reply, verifyCodeCookie, enrollment, verifyCodeSeconds);
    return reply.code(202).send({ accepted: true });
  });

  app.post('/account/email/verify-code', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    const [code] = fields(request, 'code') ?? [];
    const enrollment = readBrowserCookie(request, verifyCodeCookie);
    if (!enrollment || !code || !/^\d{6}$/.test(code)) return failure(reply, 400, 'invalid_code');
    if (!await rateAllowed(pool, [[`verify-code-attempt:${viewer.id}`, 12], [`verify-code-day:${viewer.id}`, 30, 86_400]])) {
      return failure(reply, 429, 'try_later');
    }
    const verified = await transaction(pool, async (db) => {
      const row = (await db.query<{ email: string }>(
        `DELETE FROM email_verification_codes WHERE account_id = $1 AND token_digest = $2 AND expires_at > now() AND attempts < $3 RETURNING email`,
        [viewer.id, codeKey(enrollment, code), codeAttempts])).rows[0];
      if (!row) return false;
      const account = await db.query('UPDATE accounts SET email_verified_at = now() WHERE id = $1 AND email = $2 AND enabled AND email_verified_at IS NULL',
        [viewer.id, row.email]);
      if (!account.rowCount) return false;
      await audit(db, 'account.email_verified', viewer.id, viewer.id);
      return true;
    });
    if (!verified) {
      await pool.query('UPDATE email_verification_codes SET attempts = attempts + 1 WHERE account_id = $1', [viewer.id]);
      return failure(reply, 400, 'invalid_code');
    }
    setBrowserCookie(reply, verifyCodeCookie, '', 0);
    return { verified: true };
  });

  const loginCodeCookie = '__Host-niltavi-login-code';
  const loginCodeSeconds = 900;
  const loginCodeKey = (enrollment: string, interaction?: string) =>
    web.keyFor(interaction ? enrollment + '\0' + interaction : enrollment);

  function codeSignupRefusal(email: string) {
    if (!registrationEnabled) return 'registration_unavailable';
    if (allowedDomain && email.split('@')[1] !== allowedDomain) return 'registration_domain';
  }

  async function requestLoginCode(request: FastifyRequest, reply: FastifyReply, interaction?: string) {
    const [address, invitation] = fields(request, 'email', 'invitation') ?? fields(request, 'email') ?? [];
    let email: string;
    try { email = mailAddress(address ?? ''); }
    catch { return failure(reply, 400, 'invalid_email'); }
    if (!await mailer.codes()) return failure(reply, 503, 'delivery_unavailable');
    if (!await loginRateAllowed(pool, request.ip, email, 'login-code', 5)) return failure(reply, 429, 'try_later');
    const enrollment = randomBytes(32).toString('base64url');
    const code = verificationCode();
    await pool.query('DELETE FROM login_codes WHERE expires_at <= now()');
    await pool.query(`INSERT INTO login_codes (token_digest, email, enrollment_digest, expires_at, next_resend_at)
      VALUES ($1, $2, $3, now() + $4 * interval '1 second', now() + $5 * interval '1 second')
      ON CONFLICT (enrollment_digest) DO NOTHING`,
    [codeKey(enrollment, code), email, loginCodeKey(enrollment, interaction), loginCodeSeconds, resendSeconds]);
    mailer.later(async () => {
      const account = await getLogin(pool, email);
      if (account ? account.enabled : !codeSignupRefusal(email) && !await registrationRefusal(pool, email, invitationKey(invitation))) {
        await mailer.sendCode(email, code);
      }
    });
    setBrowserCookie(reply, loginCodeCookie, enrollment, loginCodeSeconds);
    return reply.code(202).send({ accepted: true });
  }

  async function verifyLoginCode(request: FastifyRequest, reply: FastifyReply, interaction?: string) {
    const [code, invitation] = fields(request, 'code', 'invitation') ?? fields(request, 'code') ?? [];
    const enrollment = readBrowserCookie(request, loginCodeCookie);
    if (!enrollment || !code || !/^\d{6}$/.test(code)) {
      await failure(reply, 400, 'invalid_code');
      return undefined;
    }
    if (!await rateAllowed(pool, [[`login-code-verify:source:${request.ip}`, 20]])) {
      await failure(reply, 429, 'try_later');
      return undefined;
    }
    const enrollmentKey = loginCodeKey(enrollment, interaction);
    type Outcome = { id: string; epoch: number; token: string } | { error: string };
    const result = await transaction<Outcome | undefined>(pool, async (db) => {
      const row = (await db.query<{ email: string }>(
        `DELETE FROM login_codes WHERE token_digest = $1 AND enrollment_digest = $2 AND expires_at > now() AND attempts < $3 RETURNING email`,
        [codeKey(enrollment, code), enrollmentKey, codeAttempts])).rows[0];
      if (!row) return undefined;
      const findAccount = async () => (await db.query<{ id: string; security_epoch: number; enabled: boolean }>(
        'SELECT id, security_epoch, enabled FROM accounts WHERE email = $1 FOR UPDATE', [row.email])).rows[0];
      let account = await findAccount();
      if (!account) {
        const refused = codeSignupRefusal(row.email);
        if (refused) return { error: refused };
        const registered = await registerNewAccount(db, row.email, null, true, invitationKey(invitation));
        if (registered.id) {
          await audit(db, 'account.email_registered', registered.id, registered.id);
          account = { id: registered.id, security_epoch: 0, enabled: true };
        } else if (registered.error === 'email_in_use') {
          // Another request may have registered this address while this code was being checked.
          account = await findAccount();
        } else {
          return { error: registered.error };
        }
      }
      if (!account?.enabled) return undefined;
      await audit(db, 'account.signed_in', account.id, account.id, 'code');
      return { id: account.id, epoch: account.security_epoch, token: await web.issue(db, account.id, account.security_epoch, request) };
    });
    if (!result) {
      await pool.query('UPDATE login_codes SET attempts = attempts + 1 WHERE enrollment_digest = $1', [enrollmentKey]);
      await failure(reply, 400, 'invalid_code');
      return undefined;
    }
    setBrowserCookie(reply, loginCodeCookie, '', 0);
    if ('error' in result) {
      await failure(reply, 403, result.error);
      return undefined;
    }
    return result;
  }

  app.post('/account/login-code', guard, (request, reply) => requestLoginCode(request, reply));
  app.post('/account/login-verify', guard, async (request, reply) => {
    const result = await verifyLoginCode(request, reply);
    if (!result) return reply;
    web.grant(reply, result.token);
    return reply.code(204).send();
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

  // A password is only the first step for an account with two-step verification. Signing in with
  // an email code counts as both steps, because the same mailbox can reset the password anyway.
  const challengeCookie = '__Host-niltavi-sign-in-2fa';
  const challengeSeconds = 300;
  async function challengeSecondFactor(reply: FastifyReply, account: { id: string; security_epoch: number }, uid?: string) {
    const token = randomBytes(32).toString('base64url');
    await pool.query('DELETE FROM login_challenges WHERE expires_at <= now()');
    await pool.query(`INSERT INTO login_challenges (token_digest, account_id, account_epoch, interaction_uid, expires_at)
      VALUES ($1, $2, $3, $4, now() + $5 * interval '1 second')`,
    [web.keyFor(token), account.id, account.security_epoch, uid ?? null, challengeSeconds]);
    setBrowserCookie(reply, challengeCookie, token, challengeSeconds);
    return reply.code(200).send({ secondFactor: true });
  }

  // Accepts a code from the authenticator or one unused recovery code, then opens the session.
  async function completeSecondFactor(request: FastifyRequest, reply: FastifyReply, uid?: string, client?: string) {
    const [code] = fields(request, 'factor') ?? [];
    const cookie = readBrowserCookie(request, challengeCookie);
    if (!cookie || !code) { failure(reply, 400, 'second_factor_expired'); return undefined; }
    const key = web.keyFor(cookie);
    const challenge = (await pool.query<{ account_id: string; account_epoch: number }>(
      `UPDATE login_challenges SET attempts = attempts + 1
        WHERE token_digest = $1 AND expires_at > now() AND attempts < $2 AND interaction_uid IS NOT DISTINCT FROM $3
        RETURNING account_id, account_epoch`, [key, codeAttempts, uid ?? null])).rows[0];
    if (!challenge) {
      setBrowserCookie(reply, challengeCookie, '', 0);
      failure(reply, 400, 'second_factor_expired');
      return undefined;
    }
    const { account_id: id, account_epoch: epoch } = challenge;
    const recovery = recoveryValue(code);
    let usedRecovery = false;
    let accepted = false;
    if (/^\d{6}$/.test(code.trim())) accepted = await secondFactor(id, code.trim(), true);
    else if (recovery && await rateAllowed(pool, [[`recovery:${id}`, 5]])) {
      accepted = usedRecovery = Boolean((await pool.query(
        'UPDATE recovery_codes SET used_at = now() WHERE account_id = $1 AND code_digest = $2 AND used_at IS NULL',
        [id, recoveryKey(id, recovery)])).rowCount);
    }
    if (!accepted) {
      await audit(pool, 'account.sign_in_failed', id, id);
      failure(reply, 400, 'invalid_code');
      return undefined;
    }
    const token = await transaction(pool, async (db) => {
      if (!(await db.query('DELETE FROM login_challenges WHERE token_digest = $1', [key])).rowCount) return undefined;
      const live = await db.query(`SELECT 1 FROM accounts WHERE id = $1 AND enabled AND security_epoch = $2
        AND totp_confirmed_at IS NOT NULL FOR UPDATE`, [id, epoch]);
      if (!live.rowCount) return undefined;
      await audit(db, 'account.signed_in', id, id, client);
      if (usedRecovery) await audit(db, 'account.recovery_code_used', id, id);
      const issued = await web.issue(db, id, epoch, request);
      await db.query('UPDATE web_sessions SET second_factor_at = now() WHERE token_digest = $1', [web.keyFor(issued)]);
      return issued;
    });
    setBrowserCookie(reply, challengeCookie, '', 0);
    if (!token) { failure(reply, 400, 'second_factor_expired'); return undefined; }
    return { id, epoch, token, recoveryCodesLeft: await recoveryCodesLeft(id) };
  }

  // Recovery codes look like abcde-23456. Only a keyed digest is stored.
  const recoveryAlphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const recoveryKey = (account: string, code: string) => createHmac('sha256', encryptionKey).update(`recovery:${account}:${code}`).digest('base64url');
  function recoveryValue(code: string) {
    const value = code.toLowerCase().replace(/[\s-]/g, '');
    return /^[a-hjkmnp-z2-9]{10}$/.test(value) ? value : undefined;
  }
  async function issueRecoveryCodes(db: PoolClient, account: string) {
    const codes = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => recoveryAlphabet[randomInt(recoveryAlphabet.length)]).join(''));
    await db.query('DELETE FROM recovery_codes WHERE account_id = $1', [account]);
    for (const code of codes) await db.query('INSERT INTO recovery_codes (account_id, code_digest) VALUES ($1, $2)', [account, recoveryKey(account, code)]);
    return codes.map(code => `${code.slice(0, 5)}-${code.slice(5)}`);
  }
  async function recoveryCodesLeft(account: string) {
    return (await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM recovery_codes WHERE account_id = $1 AND used_at IS NULL',
      [account])).rows[0]?.count ?? 0;
  }

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
    const recoveryCodes = await transaction(pool, async (db) => {
      await db.query('UPDATE web_sessions SET second_factor_at = now() WHERE token_digest = $1', [viewer.key]);
      await audit(db, 'account.second_factor_enabled', viewer.id, viewer.id);
      return issueRecoveryCodes(db, viewer.id);
    });
    return { recoveryCodes };
  });

  app.post('/account/second-factor/verify', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    if (!await secondFactor(viewer.id, fields(request, 'code')?.[0], true)) return failure(reply, 400, 'invalid_code');
    await pool.query('UPDATE web_sessions SET second_factor_at = now() WHERE token_digest = $1', [viewer.key]);
    return reply.code(204).send();
  });

  app.post('/account/second-factor/disable-request', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    if (!fields(request)) return failure(reply, 400, 'unexpected_body');
    if (!viewer.secondFactorEnabled) return failure(reply, 409, 'second_factor_not_enabled');
    if (!await mailer.codes()) return failure(reply, 503, 'delivery_unavailable');
    if (!await rateAllowed(pool, [[`disable-2fa:${viewer.id}`, 3, 900], [`disable-2fa:source:${request.ip}`, 20]])) {
      return failure(reply, 429, 'try_later');
    }
    const enrollment = randomBytes(32).toString('base64url');
    const code = verificationCode();
    await pool.query('DELETE FROM disable_2fa_codes WHERE expires_at <= now()');
    await pool.query(`INSERT INTO disable_2fa_codes (account_id, token_digest, email, expires_at, next_resend_at)
      VALUES ($1, $2, $3, now() + $4 * interval '1 second', now() + $5 * interval '1 second')
      ON CONFLICT (account_id) DO UPDATE SET token_digest = EXCLUDED.token_digest, email = EXCLUDED.email,
        attempts = 0, expires_at = EXCLUDED.expires_at, next_resend_at = EXCLUDED.next_resend_at`,
    [viewer.id, codeKey(enrollment, code), viewer.email, disable2faSeconds, resendSeconds]);
    mailer.later(() => mailer.sendCode(viewer.email, code));
    setBrowserCookie(reply, disable2faCookie, enrollment, disable2faSeconds);
    return reply.code(202).send({ accepted: true, email: viewer.email });
  });

  app.post('/account/second-factor/disable-resend', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    if (!fields(request)) return failure(reply, 400, 'unexpected_body');
    if (!viewer.secondFactorEnabled) return failure(reply, 409, 'second_factor_not_enabled');
    if (!await mailer.codes()) return failure(reply, 503, 'delivery_unavailable');
    if (!await rateAllowed(pool, [[`disable-2fa:${viewer.id}`, 3, 900], [`disable-2fa:source:${request.ip}`, 20]])) {
      return failure(reply, 429, 'try_later');
    }
    const enrollment = randomBytes(32).toString('base64url');
    const code = verificationCode();
    const changed = await pool.query(
      `UPDATE disable_2fa_codes SET token_digest = $1, attempts = 0,
          expires_at = now() + $2 * interval '1 second', next_resend_at = now() + $3 * interval '1 second'
        WHERE account_id = $4 AND expires_at > now() AND next_resend_at <= now()`,
      [codeKey(enrollment, code), disable2faSeconds, resendSeconds, viewer.id]);
    if (!changed.rowCount) return failure(reply.header('retry-after', String(resendSeconds)), 429, 'resend_wait');
    mailer.later(() => mailer.sendCode(viewer.email, code));
    setBrowserCookie(reply, disable2faCookie, enrollment, disable2faSeconds);
    return reply.code(202).send({ accepted: true });
  });

  app.post('/account/second-factor/disable', guard, async (request, reply) => {
    const viewer = await web.viewer(request);
    if (!viewer) return failure(reply, 401, 'sign_in_required');
    const [code] = fields(request, 'code') ?? [];
    const enrollment = readBrowserCookie(request, disable2faCookie);
    if (!enrollment || !code || !/^\d{6}$/.test(code)) return failure(reply, 400, 'invalid_code');
    if (!await rateAllowed(pool, [[`disable-2fa-attempt:${viewer.id}`, 12], [`disable-2fa-day:${viewer.id}`, 30, 86_400]])) {
      return failure(reply, 429, 'try_later');
    }
    const disabled = await transaction(pool, async (db) => {
      const row = (await db.query<{ email: string }>(
        `DELETE FROM disable_2fa_codes WHERE account_id = $1 AND token_digest = $2 AND expires_at > now() AND attempts < $3 RETURNING email`,
        [viewer.id, codeKey(enrollment, code), codeAttempts])).rows[0];
      if (!row) return false;
      await db.query('UPDATE accounts SET totp_secret = NULL, totp_confirmed_at = NULL, totp_last_step = NULL WHERE id = $1', [viewer.id]);
      await db.query('UPDATE web_sessions SET second_factor_at = NULL WHERE account_id = $1', [viewer.id]);
      await db.query('DELETE FROM recovery_codes WHERE account_id = $1', [viewer.id]);
      await db.query('DELETE FROM login_challenges WHERE account_id = $1', [viewer.id]);
      await audit(db, 'account.second_factor_removed', viewer.id, viewer.id);
      return true;
    });
    if (!disabled) {
      await pool.query('UPDATE disable_2fa_codes SET attempts = attempts + 1 WHERE account_id = $1', [viewer.id]);
      return failure(reply, 400, 'invalid_code');
    }
    setBrowserCookie(reply, disable2faCookie, '', 0);
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
  return { requestLoginCode, verifyLoginCode, challengeSecondFactor, completeSecondFactor, passwordlessAvailable: mailer.codes, registerAccount, pendingEnrollment, verifyEnrollment, resendEnrollment };
}
