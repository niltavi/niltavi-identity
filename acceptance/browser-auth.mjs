import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { createServer } from 'node:tls';
import { spawn } from 'node:child_process';
import selfsigned from 'selfsigned';
import { connect, createAccount, getAccount, grantAcceptanceOperator, migrate, schemaVersion, setInstanceRole } from '../dist/database.js';
import { initializeSecrets } from '../dist/settings.js';
import { service } from '../dist/service.js';

const db = new URL(process.env.IDENTITY_ACCEPTANCE_DATABASE_URL);
assert.equal(db.pathname, '/identity_lab');
const schema = `identity_web_${randomBytes(8).toString('hex')}`;
const dbAdmin = connect(db.href);
db.searchParams.set('options', `-c search_path=${schema}`);
const pool = connect(db.href);
const files = await mkdtemp(join(tmpdir(), 'identity-web-'));
const issuer = `https://identity.localhost:${process.env.IDENTITY_WEB_TEST_PORT ?? '43863'}`;
const gateway = 'https://identity.testenv.niltavi.com';
const cert = await selfsigned.generate([{ name: 'commonName', value: 'identity.localhost' }], {
  algorithm: 'sha256',
  extensions: [{ name: 'basicConstraints', cA: false }, { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'identity.localhost' }, { type: 7, ip: '127.0.0.1' }] }],
});
const messages = [];
const smtp = createServer({ cert: cert.cert, key: cert.private }, (socket) => {
  let buffered = '';
  let data;
  socket.setEncoding('utf8');
  socket.write('220 identity-test ESMTP\r\n');
  socket.on('error', () => undefined);
  socket.on('data', (chunk) => {
    buffered += chunk;
    for (let split = buffered.indexOf('\r\n'); split >= 0; split = buffered.indexOf('\r\n')) {
      const line = buffered.slice(0, split);
      buffered = buffered.slice(split + 2);
      if (data && line === '.') {
        messages.push(data.join('\n'));
        data = undefined;
        socket.write('250 Queued\r\n');
      } else if (data) data.push(line);
      else if (line === 'DATA') {
        data = [];
        socket.write('354 End with dot\r\n');
      } else if (line === 'QUIT') socket.end('221 Bye\r\n');
      else socket.write('250 OK\r\n');
    }
  });
});
smtp.listen(0, '127.0.0.1');
await once(smtp, 'listening');
const crt = join(files, 'cert.pem');
const key = join(files, 'key.pem');
const smtpUrl = join(files, 'smtp');
await Promise.all([writeFile(crt, cert.cert), writeFile(key, cert.private),
  writeFile(smtpUrl, `smtps://127.0.0.1:${smtp.address().port}`)]);
const browserSeed = process.env.IDENTITY_LOCAL_NSS_SEED;
const providerCertificate = browserSeed ? process.env.IDENTITY_LOCAL_CERT : crt;
const providerKey = browserSeed ? process.env.IDENTITY_LOCAL_KEY : key;
const providerCA = browserSeed ? await readFile(process.env.IDENTITY_LOCAL_CA) : cert.cert;
Object.assign(process.env, { IDENTITY_ISSUER: issuer, IDENTITY_PORT: new URL(issuer).port,
  IDENTITY_HOST: '127.0.0.1', IDENTITY_TLS_CERT_FILE: providerCertificate, IDENTITY_TLS_KEY_FILE: providerKey,
  IDENTITY_SECRETS_DIR: join(files, 'secrets'), IDENTITY_SMTP_URL_FILE: smtpUrl, IDENTITY_SMTP_CA_FILE: crt,
  IDENTITY_SMTP_FROM: 'verify@identity.example.test', IDENTITY_DEPLOYMENT_PROFILE: 'acceptance', IDENTITY_ACCEPTANCE_OPERATORS: 'true',
  IDENTITY_ACCEPTANCE_OPERATOR_DOMAIN: 'niltavi.test',
  IDENTITY_GATEWAY_ISSUER: gateway });

function http(path, { body, cookie, origin = issuer, host = new URL(issuer).host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ hostname: '127.0.0.1', servername: 'identity.localhost', port: new URL(issuer).port,
      ca: providerCA, method: data === undefined ? 'GET' : 'POST', path,
      headers: { host, ...(cookie ? { cookie } : {}), ...(data === undefined ? {} : {
        origin, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
      }) },
    }, async (response) => {
      try {
        let text = '';
        for await (const chunk of response) text += chunk;
        resolve({ status: response.statusCode, body: text ? JSON.parse(text) : undefined,
          cookie: response.headers['set-cookie']?.[0], location: response.headers.location });
      } catch (error) { reject(error); }
    });
    req.setTimeout(15_000, () => req.destroy(new Error('HTTPS test timed out.')));
    req.on('error', reject);
    req.end(data);
  });
}

const email = 'browser-registration@niltavi.test';
const work = 'member@work.example.test';
const operator = 'browser-operator@niltavi.test';
const member = 'acceptance@niltavi.test';
const password = `identity-test-${randomBytes(20).toString('hex')}`;
let app;
try {
  await dbAdmin.query(`CREATE SCHEMA "${schema}"`);
  await initializeSecrets(process.env.IDENTITY_SECRETS_DIR);
  assert.deepEqual(await migrate(pool), { version: schemaVersion, changed: true });
  assert.deepEqual(await migrate(pool), { version: schemaVersion, changed: false });
  await createAccount(pool, operator, password);
  await createAccount(pool, member, password);
  // Registration opens once the instance has its first administrator.
  await setInstanceRole(pool, operator, true);
  app = await service(pool);

  const vanityHost = new URL(gateway).host;
  assert.equal((await http('/.well-known/openid-configuration')).body.issuer, issuer);
  assert.equal((await http('/.well-known/openid-configuration', { host: vanityHost })).body.issuer, gateway);
  assert.equal((await http('/account/config', { host: 'unlisted.test' })).status, 421);
  assert.equal((await http('/account/login', { host: vanityHost, body: { email: member, password } })).status, 403);
  const issued = await http('/account/login', { host: vanityHost, origin: gateway, body: { email: member, password } });
  assert.equal(issued.status, 204);
  assert.match(issued.cookie, /Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax$/);
  const vanityCookie = issued.cookie.split(';', 1)[0];
  assert.equal((await http('/account/session', { cookie: vanityCookie, host: vanityHost })).status, 200);
  assert.equal((await http('/account/session', { cookie: vanityCookie })).status, 401);

  assert.equal((await http('/account/session')).status, 401);
  assert.equal((await http('/account/register', { body: { email: 'invalid' } })).status, 400);
  assert.equal((await http('/account/register', { body: { email, password }, origin: 'https://unrelated.test' })).status, 403);
  assert.equal((await http('/account/register', { body: { email, password, name: 'Unexpected field' } })).status, 400);
  assert.equal((await http('/account/register', { body: { email, password: 'short' } })).body.error, 'invalid_password');
  const enrollment = await http('/account/register', { body: { email, password } });
  assert.equal(enrollment.status, 202);
  assert.match(enrollment.cookie, /^__Host-niltavi-enrollment=[\w-]{43}; Path=\/; Max-Age=900; HttpOnly; Secure; SameSite=Lax$/);
  const enrollmentCookie = enrollment.cookie.split(';', 1)[0];
  assert.equal((await http('/account/login', { body: { email, password } })).status, 401);
  // The message leaves after the response, so that the reply never depends on the recipient.
  const delivered = async (count) => {
    for (let i = 0; i < 100 && messages.length < count; i += 1) await new Promise((done) => setTimeout(done, 50));
    assert.equal(messages.length, count);
    return messages[count - 1].match(/^(\d{6})$/m)?.[1];
  };
  const code = await delivered(1);
  assert.ok(code);
  assert.match(messages[0], /Reply-To: support@niltavi\.com/i);
  assert.match(messages[0], /Content-Type: multipart\/alternative/i);
  assert.match(messages[0], /Content-Type: text\/plain/i);
  assert.match(messages[0], /Content-Type: text\/html/i);
  assert.match(messages[0], /Your verification code/);
  assert.equal((await http('/account/verify', { cookie: enrollmentCookie, body: { email, code: 'X'.repeat(32) } })).status, 400);
  assert.equal((await http('/account/verify', { body: { email, code } })).status, 400);
  assert.equal((await http('/account/verify', { cookie: enrollmentCookie, host: vanityHost, origin: gateway, body: { email, code } })).status, 400);
  const confirmed = { cookie: enrollmentCookie, body: { email, code } };
  const verified = await Promise.all(Array.from({ length: 2 }, () => http('/account/verify', confirmed)));
  assert.deepEqual(verified.map(({ status }) => status).sort(), [201, 400]);
  assert.equal((await http('/account/verify', confirmed)).status, 400);
  const { id } = await getAccount(pool, email);
  const workEnrollment = await http('/account/register', { body: { email: work, password } });
  assert.equal(workEnrollment.status, 202);
  const workCode = await delivered(2);
  assert.ok(workCode);
  assert.equal((await http('/account/verify', { cookie: workEnrollment.cookie.split(';', 1)[0], body: { email: work, code: workCode } })).status, 201);
  console.log('Two isolated mailbox domains, TLS SMTP delivery, cookie-bound verification, and single-use confirmation passed.');

  async function login(address) {
    const result = await http('/account/login', { body: { email: address, password } });
    assert.equal(result.status, 204);
    assert.match(result.cookie, /Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax$/);
    return result.cookie.split(';', 1)[0];
  }
  const memberCookie = await login(member);
  assert.equal((await http('/account/session', { cookie: memberCookie, host: vanityHost })).status, 401);
  assert.equal((await http('/account/logout', { cookie: vanityCookie, body: {}, host: vanityHost, origin: gateway })).status, 204);
  console.log('Exact gateway Host, issuer, CSRF, and two-way cookie isolation passed over the original TLS listener.');
  const userCookie = await login(email);
  let result = await http('/account/session', { cookie: userCookie });
  assert.equal(result.body.account.id, id);
  assert.equal(result.body.account.emailVerified, true);
  assert.equal((await http('/account/managed', { cookie: memberCookie })).body.accounts.length, 0);
  await assert.rejects(grantAcceptanceOperator(pool, member, email), /shared account/);
  await grantAcceptanceOperator(pool, operator, email);
  const operatorCookie = await login(operator);
  result = await http('/account/managed', { cookie: operatorCookie });
  assert.deepEqual(result.body.accounts, [{ id, email, enabled: true }]);
  const operation = { body: { status: 'disabled' } };
  const endpoint = `/account/managed/${id}/status`;
  assert.equal((await http(endpoint, { ...operation, cookie: memberCookie })).status, 403);
  assert.equal((await http(endpoint, { ...operation, cookie: operatorCookie })).body.changed, true);
  assert.equal((await http(endpoint, { ...operation, cookie: operatorCookie })).body.changed, false);
  assert.equal((await http('/account/session', { cookie: userCookie })).status, 401);
  assert.equal((await http('/account/login', { body: { email, password } })).status, 401);
  assert.equal((await http('/account/session', { cookie: memberCookie })).status, 200);
  console.log('Scoped operator action, repeat disable, disabled-account denial and member isolation passed.');

  await app.close();
  app = await service(pool);
  assert.equal((await http('/account/session', { cookie: memberCookie })).status, 200);
  assert.equal((await getAccount(pool, email)).enabled, false);
  const memberCookie2 = await login(member);
  assert.equal((await http('/account/session', { cookie: memberCookie })).body.account.activeSessions, 2);
  assert.equal((await http('/account/logout', { cookie: memberCookie2, body: {} })).status, 204);
  assert.equal((await http('/account/session', { cookie: memberCookie })).body.account.activeSessions, 1);
  const anotherCookie = await login(member);
  assert.equal((await http('/account/end-sessions', { cookie: memberCookie, body: {} })).status, 204);
  for (const cookie of [memberCookie, anotherCookie]) assert.equal((await http('/account/session', { cookie })).status, 401);
  console.log('Restart persistence, single-session logout and revocation of all own sessions passed.');
  if (browserSeed) {
    const website = spawn(process.execPath, ['acceptance/website.mjs', issuer], { stdio: 'inherit', windowsHide: true });
    const [status] = await once(website, 'exit');
    assert.equal(status, 0, 'Headless fixture website checks');

    const { firefox, expect } = await import('@playwright/test');
    const profile = await mkdtemp(join(files, 'profile-'));
    for (const file of ['cert9.db', 'key4.db']) await copyFile(join(browserSeed, file), join(profile, file));
    const browser = await firefox.launchPersistentContext(profile, {
      headless: true, ignoreHTTPSErrors: false, locale: 'en-US',
      firefoxUserPrefs: { 'security.enterprise_roots.enabled': false, 'network.proxy.type': 0,
        'network.dns.localDomains': new URL(issuer).hostname },
    });
    try {
      for (const address of ['browser@personal.example.test', 'browser@work.example.test']) {
        const page = await browser.newPage();
        await page.goto(issuer + '/register');
        await expect(page.locator('form input')).toHaveCount(2);
        await page.getByLabel('Email').fill(address);
        await page.getByLabel('Password').fill(password);
        const expectedMessage = messages.length + 1;
        await page.getByRole('button', { name: 'Create account', exact: true }).click();
        const codeField = page.getByLabel('Verification code', { exact: true });
        await expect(codeField).toBeVisible();
        const realCode = await delivered(expectedMessage);
        assert.ok(realCode);
        await codeField.fill(realCode === '000000' ? '111111' : '000000');
        await page.getByRole('button', { name: 'Verify and continue' }).click();
        await expect(page.getByText(/code is incorrect|code is invalid/i)).toBeVisible();
        await codeField.fill(realCode);
        await page.getByRole('button', { name: 'Verify and continue' }).click();
        await page.waitForURL(issuer + '/workspace');
        await expect(page.getByRole('heading', { name: 'Account center' })).toBeVisible();
        await expect(page.getByText('Verified', { exact: true })).toBeVisible();
        await page.reload();
        await expect(page.getByText('Verified', { exact: true })).toBeVisible();
        await page.getByRole('tab', { name: 'Sessions' }).click();
        await page.getByRole('button', { name: 'Sign out of the account center' }).click();
        await page.waitForURL(issuer + '/login');
        await page.close();
      }
      console.log('Headless registration with email and password, real fixture delivery, wrong-code check, workspace reload and logout passed on both mailbox domains.');
    } finally { await browser.close(); }
  }
} finally {
  await app?.close();
  smtp.close();
  await pool.end();
  await dbAdmin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await dbAdmin.end();
  await rm(files, { recursive: true, force: true });
}
