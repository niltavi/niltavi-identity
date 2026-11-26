// Identity-side acceptance for the product requirements: each numbered invariant has a case
// that would fail if the guarantee broke. Runs the real service in-process on a throwaway schema.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import selfsigned from 'selfsigned';
import { passwordHash, totpCode, verifyAccountPassword } from '../dist/credentials.js';
import {
  connect, createAccount, getAccount, markEmailVerified, migrate, operatorResetLink, schemaVersion, setAccountEnabled, setSetting,
} from '../dist/database.js';
import { createProtocolStore } from '../dist/protocol-store.js';
import { activateKey, initializeSecrets, retireKey, stageKey } from '../dist/settings.js';
import { service } from '../dist/service.js';
import { issueSetupLink } from '../dist/setup.js';

const db = new URL(process.env.IDENTITY_ACCEPTANCE_DATABASE_URL ?? 'postgresql://identity_lab:identity_lab@127.0.0.1:55450/identity_lab');
assert.equal(db.pathname, '/identity_lab');
const schema = `identity_prd_${randomBytes(8).toString('hex')}`;
const dbAdmin = connect(db.href);
db.searchParams.set('options', `-c search_path=${schema}`);
const pool = connect(db.href);
const files = await mkdtemp(join(tmpdir(), 'identity-prd-'));
const port = process.env.IDENTITY_PRD_TEST_PORT ?? '43910';
const issuer = `https://identity.localhost:${port}`;
const hostedIssuer = `https://identity.acceptance.niltavi.com:${port}`;
const cert = await selfsigned.generate([{ name: 'commonName', value: 'identity.localhost' }], {
  algorithm: 'sha256',
  extensions: [{ name: 'basicConstraints', cA: false }, { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'identity.localhost' },
      { type: 2, value: new URL(hostedIssuer).hostname }, { type: 7, ip: '127.0.0.1' }] }],
});

// A loopback mail relay that keeps what it receives.
const inbox = [];
const smtp = createServer((socket) => {
  let buffered = '';
  let data;
  let to;
  socket.setEncoding('utf8');
  socket.write('220 identity-test ESMTP\r\n');
  socket.on('error', () => undefined);
  socket.on('data', (chunk) => {
    buffered += chunk;
    for (let split = buffered.indexOf('\r\n'); split >= 0; split = buffered.indexOf('\r\n')) {
      const line = buffered.slice(0, split);
      buffered = buffered.slice(split + 2);
      if (data && line === '.') {
        inbox.push({ to, text: data.join('\n').replace(/=\n/g, '').replace(/=3D/g, '=') });
        data = undefined;
        socket.write('250 Queued\r\n');
      } else if (data) data.push(line);
      else if (line === 'DATA') { data = []; socket.write('354 End with dot\r\n'); }
      else if (line === 'QUIT') socket.end('221 Bye\r\n');
      else {
        const recipient = line.match(/^RCPT TO:<([^>]+)>/i);
        if (recipient) to = recipient[1];
        socket.write('250 OK\r\n');
      }
    }
  });
});
smtp.listen(0, '127.0.0.1');
await once(smtp, 'listening');
async function mail(to, pattern, since = 0) {
  for (let i = 0; i < 80; i += 1) {
    const found = inbox.slice(since).find((message) => message.to === to && pattern.test(message.text));
    if (found) return found.text.match(pattern);
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`No message for ${to} matched ${pattern}`);
}
const quiet = (ms = 400) => new Promise((done) => setTimeout(done, ms));

const crt = join(files, 'cert.pem');
const key = join(files, 'key.pem');
await Promise.all([writeFile(crt, cert.cert), writeFile(key, cert.private)]);
Object.assign(process.env, { IDENTITY_ISSUER: issuer, IDENTITY_PORT: port, IDENTITY_HOST: '127.0.0.1',
  IDENTITY_TLS_CERT_FILE: crt, IDENTITY_TLS_KEY_FILE: key, IDENTITY_SECRETS_DIR: join(files, 'secrets'),
  IDENTITY_DEPLOYMENT_PROFILE: 'self-hosted' });
for (const name of ['IDENTITY_SMTP_URL_FILE', 'IDENTITY_TENCENT_SES_CONFIG_FILE', 'IDENTITY_GATEWAY_ISSUER', 'IDENTITY_ACCEPTANCE_OPERATORS']) delete process.env[name];

// Everything the process prints is kept, to prove no secret reaches the log.
const printed = [];
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => { printed.push(String(chunk)); return write(chunk, ...rest); };
}
const secrets = new Set();
const secret = (value) => { secrets.add(value); return value; };

function http(method, path, { body, form, cookie, headers = {}, server = false, origin = issuer } = {}) {
  return new Promise((resolve, reject) => {
    const data = form ? new URLSearchParams(form).toString() : body === undefined ? undefined : JSON.stringify(body);
    const target = new URL(origin);
    const req = request({ hostname: '127.0.0.1', servername: target.hostname, port, ca: cert.cert, method, path,
      headers: { host: target.host, ...(cookie ? { cookie } : {}), ...(data === undefined ? {} : {
        ...(server ? {} : { origin }), 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'content-length': Buffer.byteLength(data),
      }), ...headers },
    }, async (response) => {
      try {
        let text = '';
        for await (const chunk of response) text += chunk;
        let json;
        try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
        resolve({ status: response.statusCode, text, body: json, cookies: response.headers['set-cookie'] ?? [], location: response.headers.location });
      } catch (error) { reject(error); }
    });
    req.setTimeout(15_000, () => req.destroy(new Error('HTTPS test timed out.')));
    req.on('error', reject);
    req.end(data);
  });
}

// One cookie jar is one browser.
function browser(origin = issuer) {
  const jar = new Map();
  const send = async (method, path, options = {}) => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const result = await http(method, path, { origin, ...options, ...(cookie ? { cookie } : {}) });
    for (const entry of result.cookies) {
      const [pair] = entry.split(';', 1);
      const at = pair.indexOf('=');
      if (pair.slice(at + 1)) jar.set(pair.slice(0, at), pair.slice(at + 1));
      else jar.delete(pair.slice(0, at));
    }
    return result;
  };
  return { jar, get: (path, options) => send('GET', path, options), post: (path, body = {}, options) => send('POST', path, { body, ...options }),
    form: (path, form, options) => send('POST', path, { form, ...options }) };
}
const clearLimits = () => pool.query('DELETE FROM login_attempts');
const passed = (line) => console.log(`ok  ${line}`);
const password = secret(`correct horse ${randomBytes(6).toString('hex')}`);
const basic = (id, value) => ({ authorization: `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(value)}`).toString('base64')}` });

async function signIn(email, secretValue = password) {
  const session = browser();
  assert.equal((await session.post('/account/login', { email, password: secretValue })).status, 204);
  return session;
}

// Runs the authorization code flow by hand, the way a registered application's server would.
function flow(app, session = browser(), extra = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(12).toString('base64url');
  const query = new URLSearchParams({ client_id: app.client_id, redirect_uri: app.callback, response_type: 'code', scope: 'openid email profile orgs',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state, nonce: 'n', ...extra });
  return {
    session, state,
    start: () => session.get(`/auth?${query}`),
    async follow(response) {
      let current = response;
      while (current.status >= 300 && current.status < 400 && current.location && !current.location.startsWith(app.callback)) {
        current = await session.get(new URL(current.location, issuer).pathname + new URL(current.location, issuer).search);
      }
      return current;
    },
    async tokens(location) {
      const code = new URL(location).searchParams.get('code');
      assert.ok(code, 'The provider returned an authorization code');
      return http('POST', '/token', { form: { grant_type: 'authorization_code', code, redirect_uri: app.callback, code_verifier: verifier },
        headers: basic(app.client_id, app.client_secret), server: true });
    },
  };
}

let app;
try {
  await initializeSecrets(process.env.IDENTITY_SECRETS_DIR);
  const hostedSchema = `${schema}_hosted`;
  const hostedDb = new URL(db);
  hostedDb.searchParams.set('options', `-c search_path=${hostedSchema}`);
  const hostedPool = connect(hostedDb.href);
  let hosted;
  try {
    const timingPassword = randomBytes(32).toString('base64url');
    assert.equal(await verifyAccountPassword(timingPassword, null, await passwordHash(timingPassword)), false);
    await dbAdmin.query(`CREATE SCHEMA "${hostedSchema}"`);
    await migrate(hostedPool);
    await setSetting(hostedPool, 'smtp', {
      host: '127.0.0.1', port: smtp.address().port, security: 'none', username: '', password: null, from: 'identity@example.test',
    });
    process.env.IDENTITY_ISSUER = hostedIssuer;
    process.env.IDENTITY_DEPLOYMENT_PROFILE = 'hosted';
    hosted = await service(hostedPool);
    const candidates = ['personal@example.test', 'work@example.org'].map(email => ({ email, session: browser(hostedIssuer) }));
    const config = (await candidates[0].session.get('/account/config')).body;
    assert.deepEqual([config.initialized, config.registrationAvailable, config.registrationPolicy], [false, true, 'open']);
    await Promise.all(candidates.map(async candidate => {
      assert.equal((await candidate.session.post('/account/register', { email: candidate.email })).status, 202);
      [, candidate.code] = await mail(candidate.email, /^(\d{6})$/m);
    }));
    assert.equal((await hostedPool.query('SELECT id FROM accounts')).rowCount, 0);
    const opened = await Promise.all(candidates.map(async ({ session, email, code }) => {
      assert.equal((await session.post('/account/verify', { email, code })).status, 201);
      const { account } = (await session.get('/account/session')).body;
      assert.equal(account.emailVerified, true);
      return account.instanceRole;
    }));
    assert.equal(opened.filter(role => role === 'owner').length, 1);
    assert.equal(opened.filter(role => role === null).length, 1);
    for (const { email } of candidates) {
      assert.equal((await browser(hostedIssuer).post('/account/login', { email, password })).status, 401);
    }
    passed('hosted signup starts open and concurrent email confirmations grant ownership to exactly one account');
  } finally {
    await hosted?.close();
    await hostedPool.end();
    await dbAdmin.query(`DROP SCHEMA IF EXISTS "${hostedSchema}" CASCADE`);
    process.env.IDENTITY_ISSUER = issuer;
    process.env.IDENTITY_DEPLOYMENT_PROFILE = 'self-hosted';
  }

  await dbAdmin.query(`CREATE SCHEMA "${schema}"`);
  assert.deepEqual(await migrate(pool), { version: schemaVersion, changed: true });
  app = await service(pool);

  // ── First run, without outgoing mail ─────────────────────────────────────────────
  const ownerPassword = secret(`owner secret ${randomBytes(6).toString('hex')}`);
  const initial = (await http('GET', '/account/config')).body;
  assert.deepEqual([initial.initialized, initial.registrationAvailable, initial.registrationPolicy], [false, true, 'open']);
  const setupToken = secret((await issueSetupLink(pool, issuer)).link.split('#')[1]);
  assert.equal((await browser().post('/account/register',
    { email: 'forged@example.test', password, instanceRole: 'owner' })).status, 400);
  const candidates = await Promise.all(['first@example.test', 'second@example.test'].map(async email => {
    const session = browser();
    assert.equal((await session.post('/account/register', { email, password: ownerPassword })).status, 201);
    const { account } = (await session.get('/account/session')).body;
    assert.equal(account.emailVerified, false);
    return { session, email, role: account.instanceRole };
  }));
  assert.equal(candidates.filter(({ role }) => role === 'owner').length, 1);
  const { session: owner, email: ownerEmail } = candidates.find(({ role }) => role === 'owner');
  const regular = candidates.find(({ role }) => role === null).session;
  assert.equal((await owner.get('/admin/api/overview')).body.role, 'owner');
  assert.equal((await regular.post('/admin/api/registration', { policy: 'closed' })).body.error, 'administrator_required');
  assert.equal((await browser().post('/admin/api/registration', { policy: 'closed' })).status, 401);
  assert.equal((await regular.post('/setup/owner', { token: setupToken, email: 'third@example.test', password })).status, 403);
  assert.equal((await http('GET', '/account/config')).body.initialized, true);
  passed('concurrent first registrations create one owner and one regular account and invalidate the old setup link');

  // Password rule: 12 to 256 characters, counted by character, breached passwords refused.
  await clearLimits();
  const register = (email, value, session = browser()) => session.post('/account/register', { email, password: value });
  assert.equal((await register('rule@example.test', 'a2345678901')).body.error, 'invalid_password');
  assert.equal((await register('rule@example.test', '1q2w3e4r5t6y')).body.error, 'common_password');
  assert.equal((await register('rule@example.test', '密'.repeat(4) + '码'.repeat(7))).body.error, 'invalid_password');
  assert.equal((await register('unicode@example.test', secret('密码需要十二个字符才可以哦'))).status, 201);
  assert.equal((await register('unrestricted@example.test', secret('松石松石石石松石石松松松'))).status, 201);
  await clearLimits();
  assert.equal((await register('long@example.test', secret('L' + randomBytes(32).toString('hex').slice(0, 63)))).status, 201);
  const member = browser();
  const memberEmail = 'member@example.test';
  const created = await register(memberEmail, password, member);
  assert.deepEqual(created.body, { created: true, emailVerified: false });
  assert.equal((await member.get('/account/session')).body.account.emailVerified, false);
  passed('password rule: 11 characters and breached passwords are refused, 12 and 64 are accepted, CJK counts per character');
  passed('without outgoing mail a registration signs in at once with an unverified address');

  // Recovery without mail: the administrator hands over a one-time link.
  assert.equal((await browser().post('/account/recover', { email: memberEmail })).status, 202);
  const resetToken = secret((await operatorResetLink(pool, memberEmail, issuer)).link.split('#')[1]);
  const newPassword = secret(`reset value ${randomBytes(6).toString('hex')}`);
  const racing = await Promise.all([1, 2].map(() => browser().post('/account/reset', { token: resetToken, password: newPassword })));
  assert.deepEqual(racing.map(({ status }) => status).sort(), [200, 400]);
  assert.equal((await browser().post('/account/reset', { token: resetToken, password: newPassword })).body.error, 'invalid_link');
  assert.equal((await member.get('/account/session')).status, 401);
  assert.equal((await browser().post('/account/login', { email: memberEmail, password })).status, 401);
  const memberSession = await signIn(memberEmail, newPassword);
  passed('invariant 4: a reset link works once, also under concurrent submits, and ends the earlier sessions');

  // ── Teams, invitations, the last owner ───────────────────────────────────────────
  const team = (await owner.post('/account/orgs', { name: 'Field Team' })).body;
  const invite = await owner.post(`/account/orgs/${team.id}/invitations`, { email: memberEmail, role: 'member' });
  assert.equal(invite.status, 201);
  assert.equal(invite.body.delivered, false);
  const inviteToken = secret(invite.body.link.split('#')[1]);
  assert.equal((await browser().post('/account/invitation', { token: inviteToken })).body.team, 'Field Team');
  assert.equal((await owner.post('/account/invitation/accept', { token: inviteToken })).body.error, 'invitation_email_mismatch');
  assert.equal((await memberSession.post('/account/invitation/accept', { token: inviteToken })).body.error, 'email_unverified');
  await markEmailVerified(pool, memberEmail);
  const accepts = await Promise.all([1, 2].map(() => memberSession.post('/account/invitation/accept', { token: inviteToken })));
  assert.deepEqual(accepts.map(({ status }) => status).sort(), [200, 404]);
  assert.equal((await memberSession.post('/account/invitation/accept', { token: inviteToken })).status, 404);
  passed('invariant 2: an unverified or different address cannot accept an invitation');
  passed('invariant 4: an invitation link is accepted exactly once');
  const ownerId = (await owner.get('/account/session')).body.account.id;
  const memberId = (await memberSession.get('/account/session')).body.account.id;
  for (const [path, body] of [[`/account/orgs/${team.id}/members/${ownerId}/remove`, {}], [`/account/orgs/${team.id}/members/${ownerId}/role`, { role: 'member' }]]) {
    assert.equal((await owner.post(path, body)).body.error, 'last_owner');
  }
  assert.equal((await memberSession.post(`/account/orgs/${team.id}/members/${ownerId}/remove`, {})).body.error, 'team_role_required');
  assert.equal((await memberSession.post(`/account/orgs/${team.id}/invitations`, { email: 'x@example.test', role: 'member' })).body.error, 'team_role_required');
  assert.equal((await owner.post(`/account/orgs/${team.id}/members/${memberId}/role`, { role: 'owner' })).body.changed, true);
  const leaving = await Promise.all([owner.post(`/account/orgs/${team.id}/members/${ownerId}/remove`, {}),
    memberSession.post(`/account/orgs/${team.id}/members/${memberId}/remove`, {})]);
  assert.deepEqual(leaving.map(({ status }) => status).sort(), [200, 409]);
  assert.equal(Number((await pool.query("SELECT count(*) FROM memberships WHERE org_id = $1 AND role = 'owner'", [team.id])).rows[0].count), 1);
  passed('invariant 6: the last owner cannot be removed, demoted or leave, even when two owners leave at the same moment');
  await pool.query("INSERT INTO memberships (org_id, account_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member') ON CONFLICT (org_id, account_id) DO UPDATE SET role = EXCLUDED.role",
    [team.id, ownerId, memberId]);

  // ── Instance console needs a second factor for every change ──────────────────────
  assert.equal((await memberSession.get('/admin/api/overview')).status, 403);
  assert.equal((await owner.get('/admin/api/overview')).body.canWrite, false);
  const registration = { id: 'app-one', name: 'App One', homeUrl: 'https://app-one.localhost:43921/' };
  assert.equal((await owner.post('/admin/api/applications', registration)).body.error, 'second_factor_not_enabled');
  assert.equal((await owner.post('/admin/api/registration', { policy: 'invite' })).body.error, 'second_factor_not_enabled');
  assert.equal((await owner.post('/admin/api/registration', { policy: 'closed' })).body.error, 'second_factor_not_enabled');
  const totp = secret((await owner.post('/account/second-factor/setup', {})).body.secret);
  assert.equal((await owner.post('/account/second-factor/enable', { code: '000000' })).status, 400);
  const firstCode = totpCode(totp);
  assert.equal((await owner.post('/account/second-factor/enable', { code: firstCode })).status, 204);
  assert.equal((await owner.post('/account/second-factor/verify', { code: firstCode })).status, 400, 'A used code is refused');
  const unverified = await signIn(ownerEmail, ownerPassword);
  assert.equal((await unverified.post('/admin/api/applications', registration)).body.error, 'second_factor_required');
  assert.equal((await unverified.get('/admin/api/accounts')).status, 200);
  const one = { ...(await owner.post('/admin/api/applications', registration)).body, callback: 'https://app-one.localhost:43921/auth/callback' };
  const two = { ...(await owner.post('/admin/api/applications', { id: 'app-two', name: 'App Two', homeUrl: 'https://app-two.localhost:43922/' })).body,
    callback: 'https://app-two.localhost:43922/auth/callback' };
  const brandingPath = `/admin/api/applications/${one.client_id}/branding`;
  const branding = { signInName: 'Brand One & Co', signInLogoUrl: 'https://assets.example.test/one.svg' };
  assert.equal((await unverified.post(brandingPath, branding)).body.error, 'second_factor_required');
  assert.equal((await owner.post(brandingPath, { ...branding, signInLogoUrl: 'http://assets.example.test/one.svg' })).status, 400);
  assert.equal((await owner.post(brandingPath, branding)).status, 200);
  secret(one.client_secret);
  secret(two.client_secret);
  assert.equal((await http('GET', '/apps/self', { headers: basic(one.client_id, one.client_secret) })).body.name, 'App One');
  assert.equal((await http('GET', '/apps/self', { headers: basic(one.client_id, two.client_secret) })).status, 401);
  passed('invariant 9: an administrator without a confirmed second factor can read the console and change nothing');

  // ── Sign-in through an application ───────────────────────────────────────────────
  const discovery = (await http('GET', '/.well-known/openid-configuration')).body;
  assert.deepEqual(discovery.response_types_supported, ['code']);
  assert.ok(!discovery.grant_types_supported.includes('implicit'));
  const stray = flow({ ...one, callback: 'https://app-one.localhost:43921/auth/callback/other' });
  const refused = await stray.start();
  assert.ok(refused.status === 400 && !refused.location, 'An unregistered redirect address is answered on Identity, never redirected');
  const noPkce = await browser().get(`/auth?${new URLSearchParams({ client_id: one.client_id, redirect_uri: one.callback, response_type: 'code', scope: 'openid', state: 's' })}`);
  assert.match(noPkce.location ?? '', /error=invalid_request/);
  assert.match((await browser().get(`/auth?${new URLSearchParams({ client_id: one.client_id, redirect_uri: one.callback, response_type: 'token', scope: 'openid', state: 's', nonce: 'n' })}`)).location ?? '', /error=unsupported_response_type/);
  passed('invariant 1: only the exact registered redirect address is used, with code and PKCE only');

  await clearLimits();
  const first = flow(one, browser(), { ui_locales: 'zh-CN' });
  const loginPage = await first.follow(await first.start());
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.text, /data-app-name="App One"/);
  assert.match(loginPage.text, /data-sign-in-name="Brand One &amp; Co"/);
  assert.match(loginPage.text, /data-sign-in-logo-url="https:\/\/assets\.example\.test\/one\.svg"/);
  assert.match(loginPage.text, /data-language="zh-CN"/);
  assert.doesNotMatch(loginPage.text, /data-passwordless=/);
  const unbranded = flow(two);
  assert.doesNotMatch((await unbranded.follow(await unbranded.start())).text, /data-sign-in-(name|logo-url)=/);
  passed('only an application with configured sign-in branding supplies it to its OIDC sign-in page');
  const interaction = loginPage.text.match(/data-registration="(\/interaction\/[\w-]+)\/register"/)[1];
  const wrong = await first.session.form(interaction, { email: memberEmail, password: 'not the password' });
  const missing = await first.session.form(interaction, { email: 'nobody@example.test', password: 'not the password' });
  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
  assert.equal(wrong.text, missing.text, 'A wrong password and an unknown address get the same page');
  assert.deepEqual((await first.session.post(interaction, { email: memberEmail, password: 'not the password' })).body,
    { error: 'invalid_credentials' });
  const signedIn = await first.follow(await first.session.form(interaction, { email: memberEmail, password: newPassword }));
  assert.ok(signedIn.location.startsWith(one.callback), 'Sign-in returns straight to the application');
  const tokens = (await first.tokens(signedIn.location)).body;
  const claims = decodeJwt(tokens.id_token);
  assert.equal(claims.sub, memberId);
  assert.equal(claims.email_verified, true);
  assert.deepEqual(claims.orgs.map(({ name, role, personal }) => [name, role, personal]), [['Personal', 'owner', true], ['Field Team', 'member', false]]);
  const replayed = await http('POST', '/token', { form: { grant_type: 'authorization_code', code: new URL(signedIn.location).searchParams.get('code'),
    redirect_uri: one.callback, code_verifier: 'x'.repeat(43) }, headers: basic(one.client_id, one.client_secret), server: true });
  assert.equal(replayed.body.error, 'invalid_grant');
  passed('invariant 4: an authorization code is exchanged once');
  passed('the ID token carries sub, verified email, name and the team list with roles');

  // The second application in the same browser needs no input.
  const second = flow(two, first.session);
  const silent = await second.follow(await second.start());
  assert.ok(silent.location?.startsWith(two.callback), 'An existing central session signs in to the second application with no page in between');
  const secondClaims = decodeJwt((await second.tokens(silent.location)).body.id_token);
  assert.equal(secondClaims.sub, claims.sub);
  // A browser signed in to the account center also needs no input.
  const viaCenter = flow(one, await signIn(memberEmail, newPassword));
  assert.ok((await viaCenter.follow(await viaCenter.start())).location?.startsWith(one.callback));
  passed('single sign-on: the second application and an account-center session both continue with zero input');

  // A request opened in another browser, or after it expired, names the application to return to.
  assert.match((await browser().get('/interaction/' + 'A'.repeat(21))).text, /data-protocol="expired"/);

  // Registration from inside a sign-in request returns to the application without an extra page.
  await clearLimits();
  const fresh = flow(one, browser(), { ui_locales: 'zh-CN' });
  const freshLogin = await fresh.follow(await fresh.start());
  const freshInteraction = freshLogin.text.match(/data-registration="(\/interaction\/[\w-]+\/register)"/)[1];
  const elsewhere = await browser().get(freshInteraction.replace('/register', ''));
  assert.equal(elsewhere.status, 400);
  assert.match(elsewhere.text, /data-protocol="expired"/);
  assert.match(elsewhere.text, /data-app-name="App One"/);
  assert.match(elsewhere.text, /data-app-url="https:\/\/app-one\.localhost:43921\/"/);
  const registrationPage = await fresh.session.get(freshInteraction);
  assert.equal(registrationPage.status, 200);
  assert.match(registrationPage.text, /data-protocol="register"/);
  assert.match(registrationPage.text, /data-sign-in-name="Brand One &amp; Co"/);
  assert.match(registrationPage.text, /data-language="zh-CN"/);
  assert.match(registrationPage.text, /data-login-path="\/interaction\/[\w-]+"/);
  assert.equal((await browser().get(freshInteraction)).status, 400);
  const signup = await fresh.session.post(freshInteraction, { email: 'newcomer@example.test', password });
  assert.match(signup.body.continueTo, /^\/interaction\/[\w-]+\/registered$/);
  const returned = await fresh.follow(await fresh.session.get(signup.body.continueTo));
  assert.ok(returned.location?.startsWith(one.callback), 'A new account lands on the application callback directly');
  assert.equal(new URL(returned.location).searchParams.get('state'), fresh.state);
  assert.equal(decodeJwt((await fresh.tokens(returned.location)).body.id_token).email, 'newcomer@example.test');
  assert.equal((await fresh.session.get(signup.body.continueTo)).status, 400, 'The continuation link completes one request once');
  passed('a new registration returns to the application with no intermediate page');

  // ── What applications ask Identity ───────────────────────────────────────────────
  const check = (client, sub, sid) => http('POST', '/apps/session', { body: { sub, sid }, headers: basic(client.client_id, client.client_secret), server: true });
  assert.equal((await check(one, claims.sub, claims.sid)).body.active, true);
  assert.equal((await check(two, claims.sub, claims.sid)).body.active, false, 'A session ID belongs to one application');
  assert.equal((await check(two, secondClaims.sub, secondClaims.sid)).body.orgs.length, 2);
  assert.equal((await owner.post(`/account/orgs/${team.id}/members/${memberId}/remove`, {})).status, 200);
  assert.deepEqual((await check(one, claims.sub, claims.sid)).body.orgs.map(({ name }) => name), ['Personal']);
  passed('invariant 5: a removed member is gone from the next session check of every application');
  await pool.query("INSERT INTO memberships (org_id, account_id, role) VALUES ($1, $2, 'member')", [team.id, memberId]);

  // Agent access tokens.
  const personal = (await memberSession.get('/account/orgs')).body.orgs.find((org) => org.personal).id;
  assert.equal((await memberSession.post('/account/tokens', { name: 'CLI', app: one.client_id, org: 'not-a-team', days: '' })).status, 400);
  const agent = (await memberSession.post('/account/tokens', { name: 'CLI', app: one.client_id, org: team.id, days: '30' })).body;
  secret(agent.token);
  const verify = (client, token) => http('POST', '/apps/agent-token', { body: { token }, headers: basic(client.client_id, client.client_secret), server: true });
  const verified = (await verify(one, agent.token)).body;
  assert.equal(verified.active, true);
  assert.equal(verified.account.sub, memberId);
  assert.deepEqual([verified.org.org_id, verified.org.role], [team.id, 'member']);
  assert.equal((await verify(two, agent.token)).body.active, false, 'A token is bound to one application');
  assert.ok(!JSON.stringify((await memberSession.get('/account/tokens')).body).includes(agent.token), 'The token value is shown once');
  await pool.query("UPDATE agent_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1", [agent.id]);
  assert.equal((await verify(one, agent.token)).body.active, false, 'An expired token is refused');
  await pool.query("UPDATE agent_tokens SET expires_at = now() + interval '1 day' WHERE id = $1", [agent.id]);
  const keeper = (await memberSession.post('/account/tokens', { name: 'Kept', app: one.client_id, org: personal, days: '' })).body;
  secret(keeper.token);
  assert.equal((await memberSession.post(`/account/tokens/${agent.id}/revoke`, {})).status, 204);
  assert.equal((await verify(one, agent.token)).body.active, false, 'A revoked token is refused');
  assert.equal((await verify(one, keeper.token)).body.org.personal, true);
  passed('Agent tokens: bound to one application and team, shown once, refused once revoked or expired');

  // Service tokens and key rotation.
  const serviceToken = async (client, audience) => http('POST', '/apps/service-token', { body: { audience }, headers: basic(client.client_id, client.client_secret), server: true });
  const issued = (await serviceToken(one, two.client_id)).body;
  assert.equal(issued.expires_in, 300);
  assert.equal((await serviceToken(one, 'unknown-app')).status, 400);
  const jwks = async () => createLocalJWKSet((await http('GET', '/jwks')).body);
  const proof = await jwtVerify(issued.access_token, await jwks(), { issuer, audience: two.client_id });
  assert.equal(proof.payload.client_id, one.client_id);
  assert.ok(proof.payload.exp - proof.payload.iat === 300);
  await assert.rejects(jwtVerify(issued.access_token, await jwks(), { issuer, audience: one.client_id }));
  await assert.rejects(jwtVerify(issued.access_token, await jwks(), { issuer, audience: two.client_id, currentDate: new Date(Date.now() + 301_000) }), /exp/);
  passed('service tokens: five minutes, one audience, verifiable from the published keys, refused once expired');

  const oldKid = decodeProtectedHeader(issued.access_token).kid;
  const staged = await stageKey(process.env.IDENTITY_SECRETS_DIR);
  await app.close();
  app = await service(pool);
  assert.equal((await http('GET', '/jwks')).body.keys.length, 2, 'The next key is published before it signs');
  assert.equal(decodeProtectedHeader((await serviceToken(one, two.client_id)).body.access_token).kid, oldKid);
  await activateKey(process.env.IDENTITY_SECRETS_DIR, staged.kid);
  await app.close();
  app = await service(pool);
  await jwtVerify(issued.access_token, await jwks(), { issuer, audience: two.client_id });
  await jwtVerify(tokens.id_token, await jwks(), { issuer, audience: one.client_id });
  assert.equal(decodeProtectedHeader((await serviceToken(one, two.client_id)).body.access_token).kid, staged.kid);
  assert.equal((await memberSession.get('/account/session')).status, 200);
  assert.equal((await check(one, claims.sub, claims.sid)).body.active, true);
  const again = flow(two, first.session);
  assert.ok((await again.follow(await again.start())).location?.startsWith(two.callback), 'The central session survives the rotation');
  await assert.rejects(retireKey(process.env.IDENTITY_SECRETS_DIR, staged.kid), /no longer signs/);
  assert.equal((await retireKey(process.env.IDENTITY_SECRETS_DIR, oldKid)).changed, true);
  passed('invariant 7: tokens signed by the old key verify through the rotation and signed-in users notice nothing');

  // Signing out of all applications in a browser ends its central session and its account-center session.
  const departing = flow(one, await signIn('newcomer@example.test'));
  const departingTokens = (await departing.tokens((await departing.follow(await departing.start())).location)).body;
  const departingClaims = decodeJwt(departingTokens.id_token);
  const confirm = await departing.session.get(`/session/end?${new URLSearchParams({ client_id: one.client_id, id_token_hint: departingTokens.id_token,
    post_logout_redirect_uri: 'https://app-one.localhost:43921/auth/signed-out' })}`);
  assert.match(confirm.text, /data-protocol="logout"/);
  const signedOutEverywhere = await departing.session.form('/session/end/confirm', { xsrf: confirm.text.match(/name="xsrf" value="([^"]+)"/)[1], logout: 'yes' });
  assert.ok(signedOutEverywhere.location?.startsWith('https://app-one.localhost:43921/auth/signed-out'));
  await quiet(100);
  assert.equal((await http('POST', '/apps/session', { body: { sub: departingClaims.sub, sid: departingClaims.sid }, headers: basic(one.client_id, one.client_secret), server: true })).body.active, false);
  assert.equal((await departing.session.get('/account/session')).status, 401);
  const afterwards = flow(one, departing.session);
  assert.match((await afterwards.follow(await afterwards.start())).text, /data-protocol="login"/, 'The next sign-in asks for the password again');
  passed('signing out of all applications in a browser ends the central and account-center sessions, so the next sign-in asks again');

  // ── Revocation ───────────────────────────────────────────────────────────────────
  const sessions = (await memberSession.get('/account/sessions')).body.sessions;
  const central = sessions.find((entry) => entry.kind === 'applications' && entry.applications.includes('App One'));
  assert.ok(central && sessions.some((entry) => entry.kind === 'account' && entry.current));
  const savedSession = (await pool.query("SELECT payload FROM oidc_records WHERE model = 'Session' AND storage_key = $1",
    [central.id])).rows[0].payload;
  const revokeCentral = () => memberSession.post('/account/sessions/revoke', { kind: 'applications', id: central.id });
  const revocations = await Promise.all([revokeCentral(), revokeCentral()]);
  assert.deepEqual(revocations.map(({ status }) => status).sort(), [204, 404]);
  const { Adapter } = createProtocolStore(pool);
  const sessionAdapter = new Adapter('Session');
  await assert.rejects(sessionAdapter.upsert(savedSession.jti, savedSession, 60), { error: 'invalid_grant' },
    'An authorization request that loaded the session before revocation cannot save the old session');
  assert.equal((await check(one, claims.sub, claims.sid)).body.active, false, 'Revoking one central session ends its application sessions');
  const other = flow(one, await signIn(memberEmail, newPassword));
  const otherClaims = decodeJwt((await other.tokens((await other.follow(await other.start())).location)).body.id_token);
  assert.equal((await check(one, otherClaims.sub, otherClaims.sid)).body.active, true);
  assert.equal((await memberSession.post('/account/end-sessions', {})).status, 204);
  assert.equal((await check(one, otherClaims.sub, otherClaims.sid)).body.active, false, 'Signing out everywhere ends every application session');
  assert.equal((await other.session.get('/account/session')).status, 401);
  const before = flow(one, await signIn(memberEmail, newPassword));
  const beforeClaims = decodeJwt((await before.tokens((await before.follow(await before.start())).location)).body.id_token);
  await setAccountEnabled(pool, memberEmail, false);
  assert.equal((await check(one, beforeClaims.sub, beforeClaims.sid)).body.active, false);
  assert.equal((await verify(one, keeper.token)).body.active, false, 'A disabled account’s Agent tokens stop working');
  await app.close();
  app = await service(pool);
  assert.equal((await check(one, beforeClaims.sub, beforeClaims.sid)).body.active, false, 'The revocation survives a restart');
  const disabledLogin = await browser().post('/account/login', { email: memberEmail, password: newPassword });
  const unknownLogin = await browser().post('/account/login', { email: 'nobody@example.test', password: newPassword });
  assert.deepEqual([disabledLogin.status, disabledLogin.body], [unknownLogin.status, unknownLogin.body]);
  await setAccountEnabled(pool, memberEmail, true);
  assert.equal((await check(one, beforeClaims.sub, beforeClaims.sid)).body.active, false, 'Re-enabling does not revive an ended session');
  passed('invariant 5: single-session revoke, sign-out everywhere and disabling take effect at the next check and survive a restart');

  // One application's grants can be revoked without ending the central session.
  const device = await signIn(memberEmail, newPassword);
  async function openFrom(registeredApp, session) {
    const visit = flow(registeredApp, session);
    const result = await visit.tokens((await visit.follow(await visit.start())).location);
    assert.equal(result.status, 200);
    return { ...result.body, sid: decodeJwt(result.body.id_token).sid };
  }
  const appOne = await openFrom(one, device);
  const appTwo = await openFrom(two, device);
  const secondDevice = await signIn(memberEmail, newPassword);
  const secondAppOne = await openFrom(one, secondDevice);
  const revokeApp = `/account/applications/${one.client_id}/revoke`;
  const userInfo = (token) => http('GET', '/me', { headers: { authorization: `Bearer ${token}` } });
  const authorized = await device.get('/account/applications');
  assert.equal(authorized.status, 200, authorized.text);
  assert.deepEqual(authorized.body.applications.map(({ id }) => id), [one.client_id, two.client_id]);
  assert.equal((await device.post(revokeApp, { password: 'wrong password' })).body.error, 'incorrect_password');
  assert.equal((await check(one, memberId, appOne.sid)).body.active, true);
  const expired = await signIn(memberEmail, newPassword);
  const expiredToken = expired.jar.get('__Host-niltavi-session');
  const expiredKey = createHash('sha256').update(expiredToken).digest('base64url');
  await pool.query("UPDATE web_sessions SET expires_at = now() - interval '1 minute' WHERE token_digest = $1", [expiredKey]);
  assert.equal((await expired.post(revokeApp, { password: newPassword })).status, 401);
  assert.equal((await userInfo(appOne.access_token)).status, 200);
  assert.equal((await device.post(revokeApp, { password: newPassword })).status, 204);
  assert.equal((await device.get('/account/session')).status, 200);
  assert.equal((await check(one, memberId, appOne.sid)).body.active, false);
  assert.equal((await check(one, memberId, secondAppOne.sid)).body.active, false);
  assert.equal((await userInfo(appOne.access_token)).status, 401);
  assert.equal((await http('POST', '/token', { form: { grant_type: 'refresh_token', refresh_token: secondAppOne.refresh_token },
    headers: basic(one.client_id, one.client_secret), server: true })).body.error, 'invalid_grant');
  assert.equal((await check(two, memberId, appTwo.sid)).body.active, true);
  await app.close();
  app = await service(pool);
  assert.equal((await check(one, memberId, appOne.sid)).body.active, false);
  const reauthorized = await openFrom(one, device);
  assert.notEqual(reauthorized.sid, appOne.sid);
  assert.equal((await check(one, memberId, appOne.sid)).body.active, false);
  assert.equal((await check(one, memberId, reauthorized.sid)).body.active, true);
  passed('application revocation requires a fresh password and session, ends old tokens and sessions on every device, and leaves other apps signed in');

  // ── Rate limits ──────────────────────────────────────────────────────────────────
  await clearLimits();
  const attempts = async (email) => {
    const results = [];
    for (let i = 0; i < 11; i += 1) results.push(await browser().post('/account/login', { email, password: 'not the password' }));
    return results.map(({ status, body }) => `${status}:${body.error}`);
  };
  const [known, unknown] = [await attempts(memberEmail), await attempts('nobody@example.test')];
  assert.deepEqual(known, unknown, 'The limit answers the same for a real and an unknown address');
  assert.equal(known.at(-1), '429:try_later');
  assert.equal(known.at(9), '401:invalid_credentials');
  assert.equal((await browser().post('/account/login', { email: memberEmail, password: newPassword })).status, 429, 'The correct password is also held back');
  const recoveries = async (email) => {
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push((await browser().post('/account/recover', { email })).status);
    return results;
  };
  assert.deepEqual(await recoveries(memberEmail), [202, 202, 202, 429]);
  assert.deepEqual(await recoveries('nobody@example.test'), [202, 202, 202, 429]);
  passed('invariant 8: password attempts and recovery requests are limited per address, with identical answers for unknown addresses');
  await clearLimits();
  await pool.query('DELETE FROM account_links');

  // ── With outgoing mail configured by the owner ───────────────────────────────────
  const mailSettings = { host: '127.0.0.1', port: String(smtp.address().port), security: 'none', username: 'relay-user',
    password: secret(`relay ${randomBytes(6).toString('hex')}`), from: 'identity@example.test' };
  assert.equal((await owner.post('/admin/api/mail', { ...mailSettings, host: 'smtp.example.test' })).body.error, 'mail_tls_required');
  assert.equal((await owner.post('/admin/api/mail', { ...mailSettings, port: '1' })).body.error, 'mail_test_failed');
  assert.equal((await owner.post('/admin/api/mail', mailSettings)).status, 202);
  const [, testCode] = await mail(ownerEmail, /confirm the settings:\s+(\d{6})/);
  assert.equal((await http('GET', '/account/config')).body.registrationMode, 'immediate', 'Unconfirmed settings are not used');
  assert.equal((await owner.post('/admin/api/mail/confirm', { code: testCode === '000000' ? '111111' : '000000' })).status, 400);
  assert.equal((await owner.post('/admin/api/mail/confirm', { code: testCode })).body.confirmed, true);
  await quiet(100);
  const config = (await http('GET', '/account/config')).body;
  assert.deepEqual([config.registrationMode, config.recoveryAvailable], ['verify-email', true]);
  passed('outgoing mail is saved only after the owner confirms the code from a real test message');

  const otp = flow(one, browser(), { prompt: 'login' });
  const started = await otp.start();
  const loginPath = new URL(started.location, issuer).pathname;
  assert.match((await otp.follow(started)).text, /data-passwordless="true"/);
  const mailStart = inbox.length;
  assert.equal((await otp.session.post(loginPath, { email: memberEmail })).status, 202);
  const [, loginCode] = await mail(memberEmail, /^(\d{6})$/m, mailStart);
  assert.equal((await browser().post(loginPath, { code: loginCode })).body.error, 'interaction_expired');
  assert.equal((await otp.session.post('/account/login-verify', { code: loginCode })).body.error, 'invalid_code');
  const verifiedLogin = await otp.session.post(loginPath, { code: loginCode });
  assert.equal(verifiedLogin.status, 200);
  assert.match(verifiedLogin.body.continueTo, /^\/auth\//);
  const returnedToApp = await otp.follow(await otp.session.get(verifiedLogin.body.continueTo));
  assert.ok(returnedToApp.location.startsWith(one.callback));
  assert.equal(decodeJwt((await otp.tokens(returnedToApp.location)).body.id_token).sub, memberId);
  assert.equal((await otp.session.get('/account/session')).body.account.id, memberId);
  passed('sign-in with an email code completes the original app request and opens an Identity session');

  const signupFlow = flow(one);
  const signupStart = await signupFlow.start();
  const signupLogin = new URL(signupStart.location, issuer).pathname;
  const signupRegister = signupLogin + '/register';
  const signupAddress = 'branded-registration@example.test';
  const signupMailStart = inbox.length;
  assert.equal((await signupFlow.session.post(signupRegister, { email: signupAddress })).status, 202);
  const [, signupCode] = await mail(signupAddress, /^(\d{6})$/m, signupMailStart);
  assert.equal((await signupFlow.session.get(signupLogin)).status, 200);
  assert.equal((await signupFlow.session.get(signupRegister)).status, 200);
  assert.equal((await signupFlow.session.get(signupRegister + '/enrollment')).body.email, signupAddress);
  assert.equal((await signupFlow.session.get('/account/enrollment')).status, 404);
  const signupVerified = await signupFlow.session.post(signupRegister, { email: signupAddress, code: signupCode });
  assert.equal(signupVerified.status, 201);
  const signupResumed = await signupFlow.session.get(signupRegister);
  assert.equal(signupResumed.location, signupVerified.body.continueTo);
  const signupReturned = await signupFlow.follow(signupResumed);
  assert.equal(new URL(signupReturned.location).searchParams.get('state'), signupFlow.state);
  assert.equal(decodeJwt((await signupFlow.tokens(signupReturned.location)).body.id_token).email, signupAddress);
  passed('branded registration survives back navigation and verification resumes the same application request');

  // Registration answers the same for a new and an existing address.
  const timed = async (email) => {
    const started = performance.now();
    const response = await browser().post('/account/register', { email, password });
    return { status: response.status, body: JSON.stringify(response.body), ms: performance.now() - started };
  };
  const mark = inbox.length;
  const existing = await timed(memberEmail);
  await clearLimits();
  const novel = await timed('brand-new@example.test');
  assert.deepEqual([existing.status, existing.body], [novel.status, novel.body]);
  assert.ok(Math.abs(existing.ms - novel.ms) < 250, `Registration timing differs by ${Math.abs(existing.ms - novel.ms).toFixed(0)} ms`);
  await mail(memberEmail, /already has an account/, mark);
  await mail('brand-new@example.test', /verification code/, mark);
  const recoverTimed = async (email) => {
    const started = performance.now();
    const response = await browser().post('/account/recover', { email });
    return { status: response.status, body: JSON.stringify(response.body), ms: performance.now() - started };
  };
  const [realRecovery, fakeRecovery] = [await recoverTimed(memberEmail), await recoverTimed('nobody@example.test')];
  assert.deepEqual([realRecovery.status, realRecovery.body], [fakeRecovery.status, fakeRecovery.body]);
  assert.ok(Math.abs(realRecovery.ms - fakeRecovery.ms) < 250);
  passed('invariant 3 with outgoing mail: registration, failed sign-in and recovery match for existing and unknown addresses');

  // Verification code: six digits, single use, spent after five wrong guesses.
  await clearLimits();
  const guesser = browser();
  let inboxMark = inbox.length;
  assert.equal((await guesser.post('/account/register', { email: 'guess@example.test', password })).status, 202);
  const [, guessCode] = await mail('guess@example.test', /^(\d{6})$/m, inboxMark);
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await guesser.post('/account/verify', { email: 'guess@example.test', code: guessCode === '123456' ? '654321' : '123456' })).status, 400);
  }
  assert.equal((await guesser.post('/account/verify', { email: 'guess@example.test', code: guessCode })).status, 400, 'Five wrong guesses spend the code');
  await clearLimits();
  const enroller = browser();
  inboxMark = inbox.length;
  assert.equal((await enroller.post('/account/register', { email: 'verified@example.test', password })).status, 202);
  const [, code] = await mail('verified@example.test', /^(\d{6})$/m, inboxMark);
  secret(`code:${code}`);
  assert.equal((await browser().post('/account/verify', { email: 'verified@example.test', code })).status, 400, 'The code works only in the browser that asked');
  const confirmations = await Promise.all([1, 2].map(() => enroller.post('/account/verify', { email: 'verified@example.test', code })));
  assert.deepEqual(confirmations.map(({ status }) => status).sort(), [201, 400]);
  assert.equal((await enroller.get('/account/session')).body.account.emailVerified, true);
  passed('invariant 4: a verification code is single-use, browser-bound and spent after five wrong guesses');

  // Self-service recovery by mail. An unverified address gets nothing.
  await clearLimits();
  inboxMark = inbox.length;
  const stale = await signIn('verified@example.test');
  assert.equal((await stale.post('/account/preferences', { locale: 'zh-CN' })).status, 204);
  assert.equal((await stale.post('/account/profile', { name: 'Verified User' })).status, 204);
  assert.equal((await stale.get('/account/session')).body.account.locale, 'zh-CN');
  assert.equal((await browser().post('/account/recover', { email: 'verified@example.test' })).status, 202);
  assert.equal((await browser().post('/account/recover', { email: 'unicode@example.test' })).status, 202);
  const [, mailedToken] = await mail('verified@example.test', /\/zh\/reset#([\w-]{43})/, inboxMark);
  secret(mailedToken);
  await quiet();
  assert.ok(!inbox.slice(inboxMark).some(({ to }) => to === 'unicode@example.test'), 'An unverified address receives no recovery link');
  const recovered = browser();
  const mailedPassword = secret(`mailed reset ${randomBytes(6).toString('hex')}`);
  assert.equal((await recovered.post('/account/reset', { token: mailedToken, password: 'qwerty123456' })).body.error, 'common_password');
  const resetResult = await recovered.post('/account/reset', { token: mailedToken, password: mailedPassword });
  assert.deepEqual([resetResult.status, resetResult.body.agentTokens], [200, []]);
  assert.equal((await recovered.post('/account/reset', { token: mailedToken, password: mailedPassword })).status, 400);
  assert.equal((await stale.get('/account/session')).status, 401);
  assert.equal((await recovered.get('/account/session')).status, 200);
  passed('invariant 2: recovery mail goes only to a verified address; the mailed link resets once and ends old sessions');

  // Invitation by mail, and invite-only registration.
  inboxMark = inbox.length;
  const mailedInvite = await owner.post(`/account/orgs/${team.id}/invitations`, { email: 'invited@example.test', role: 'admin' });
  assert.equal(mailedInvite.body.delivered, true);
  const [, mailedInviteToken] = await mail('invited@example.test', /\/invite#([\w-]{43})/, inboxMark);
  assert.equal(mailedInviteToken, mailedInvite.body.link.split('#')[1]);
  secret(mailedInviteToken);
  const pending = browser();
  const pendingEmail = 'pending-policy@example.test';
  await clearLimits();
  assert.equal((await pending.post('/account/register', { email: pendingEmail })).status, 202);
  const [, pendingCode] = await mail(pendingEmail, /^(\d{6})$/m);
  assert.equal((await owner.post('/admin/api/registration', { policy: 'invite' })).body.registration, 'invite');
  await clearLimits();
  assert.equal((await pending.post('/account/verify', { email: pendingEmail, code: pendingCode })).body.error, 'invitation_required');
  assert.equal((await browser().post('/account/register', { email: 'stranger@example.test', password })).body.error, 'invitation_required');
  assert.equal((await browser().post('/account/register', { email: 'stranger@example.test', password, invitation: mailedInviteToken })).body.error, 'invitation_required');
  const invited = browser();
  inboxMark = inbox.length;
  assert.equal((await invited.post('/account/register', { email: 'invited@example.test', password, invitation: mailedInviteToken })).status, 202);
  const [, invitedCode] = await mail('invited@example.test', /^(\d{6})$/m, inboxMark);
  assert.equal((await invited.post('/account/verify', { email: 'invited@example.test', code: invitedCode })).status, 201);
  assert.equal((await invited.post('/account/invitation/accept', { token: mailedInviteToken })).body.org, team.id);
  assert.equal((await invited.get(`/account/orgs/${team.id}`)).body.org.role, 'admin');
  assert.equal((await owner.post('/admin/api/registration', { policy: 'open' })).status, 200);
  passed('one invitation: a new address registers, verifies and joins the team; invite-only instances refuse everyone else');

  const closing = browser();
  const closingEmail = 'pending-close@example.test';
  await clearLimits();
  assert.equal((await closing.post('/account/register', { email: closingEmail })).status, 202);
  const [, closingCode] = await mail(closingEmail, /^(\d{6})$/m);
  assert.equal((await owner.post('/admin/api/registration', { policy: 'closed' })).body.registration, 'closed');
  assert.equal((await closing.get('/account/config')).body.registrationAvailable, false);
  assert.equal((await closing.post('/account/resend')).body.error, 'registration_unavailable');
  assert.equal((await closing.post('/account/verify', { email: closingEmail, code: closingCode })).body.error, 'registration_unavailable');
  assert.equal((await browser().post('/account/register', { email: closingEmail })).body.error, 'registration_unavailable');
  assert.equal((await browser().post('/account/login', { email: ownerEmail, password: ownerPassword })).status, 204);
  assert.equal((await owner.post('/admin/api/registration', { policy: 'open' })).status, 200);
  assert.equal((await closing.get('/account/config')).body.registrationAvailable, true);
  assert.equal((await closing.get('/account/session')).status, 401);
  passed('an administrator can close registration even for pending codes, and existing accounts can still sign in');

  // Account deletion is requested by the user and carried out by an administrator.
  const invitedId = (await invited.get('/account/session')).body.account.id;
  assert.equal((await invited.post('/account/deletion-request', { state: 'requested' })).status, 204);
  assert.equal((await owner.get('/admin/api/accounts')).body.accounts[0].id, invitedId);
  assert.equal((await owner.post(`/admin/api/accounts/${invitedId}/delete`, {})).body.deleted, true);
  assert.equal((await invited.get('/account/session')).status, 401);
  assert.equal((await browser().post('/account/login', { email: 'invited@example.test', password })).status, 401);
  assert.equal((await owner.post(`/admin/api/accounts/${memberId}/status`, { status: 'disabled' })).body.changed, true);
  assert.equal((await getAccount(pool, memberEmail)).enabled, false);

  // ── Nothing sensitive in the audit trail, the database or the log ────────────────
  const actions = new Set((await pool.query('SELECT DISTINCT action FROM audit_events')).rows.map(({ action }) => action));
  for (const action of ['account.signed_in', 'account.sign_in_failed', 'account.password_reset', 'account.recovery_requested', 'account.reset_link_issued',
    'team.member_invited', 'team.member_joined', 'team.member_removed', 'team.member_role_changed', 'application.registered',
    'agent_token.issued', 'agent_token.revoked', 'service_token.issued', 'account.disabled', 'account.deleted', 'account.sessions_ended',
    'instance.mail_configured', 'instance.initialized']) assert.ok(actions.has(action), `The audit trail records ${action}`);
  for (const value of [password, newPassword, ownerPassword, mailedPassword]) secrets.add(value);
  const tables = (await pool.query('SELECT tablename FROM pg_tables WHERE schemaname = $1', [schema])).rows.map(({ tablename }) => tablename);
  let stored = '';
  for (const table of tables) stored += (await pool.query(`SELECT coalesce(string_agg(to_jsonb(t)::text, '\n'), '') AS rows FROM "${table}" t`)).rows[0].rows;
  const output = printed.join('');
  for (const value of secrets) {
    const needle = value.startsWith('code:') ? undefined : value;
    if (!needle) continue;
    assert.ok(!stored.includes(needle), 'No password, token, link or application secret is stored in readable form');
    assert.ok(!output.includes(needle), 'No password, token, link or application secret is printed');
  }
  const trail = (await pool.query("SELECT coalesce(string_agg(to_jsonb(e)::text, '\n'), '') AS rows FROM audit_events e")).rows[0].rows;
  assert.ok(!/redirect_uri|code_challenge|client_secret|password=/.test(trail + output));
  passed('invariant 10: passwords, codes, tokens, links and request parameters are absent from the audit trail, the database and the log');
  console.log('\nAll Identity-side product requirements passed.');
} finally {
  await app?.close();
  smtp.close();
  await pool.end();
  await dbAdmin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await dbAdmin.end();
  await rm(files, { recursive: true, force: true });
}
