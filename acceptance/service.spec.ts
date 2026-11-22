import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import type { JWK } from 'jose';
import { expect, firefox, test as suite } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Pool } from 'pg';
import selfsigned from 'selfsigned';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { createClient, hosts, loginCookie } from '../lab/fixtures.js';
import { buildRelyingParty } from '../lab/relying-party.js';

const execute = promisify(execFile);
type RP = Awaited<ReturnType<typeof buildRelyingParty>>;
const strictSeed = process.env.IDENTITY_LOCAL_NSS_SEED;
const test = strictSeed ? suite.extend({
  context: async ({}, use) => {
    const profile = await mkdtemp(join(tmpdir(), 'identity-local-firefox-'));
    try {
      await Promise.all(['cert9.db', 'key4.db'].map(file => copyFile(join(strictSeed, file), join(profile, file))));
      const context = await firefox.launchPersistentContext(profile, {
        headless: true, ignoreHTTPSErrors: false,
        firefoxUserPrefs: { 'network.proxy.type': 0, 'network.dns.localDomains': hosts.join(','), 'security.enterprise_roots.enabled': false },
      });
      try { await use(context); } finally { await context.close(); }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  },
}) : suite;

async function authorize(page: Page, rp: RP) {
  await page.goto(rp.spec.origin);
  await page.getByRole('link', { name: 'Sign in' }).click();
}

async function credentials(page: Page, email: string, password: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function expectLogin(page: Page, rp: RP) {
  await expect(page.getByText('Signed in', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(`${rp.spec.origin}/`);
}

async function issueCode(page: Page, rp: RP) {
  const flow = await rp.authorize();
  rp.holdCallback(flow.state);
  await page.goto(flow.url.href);
  const redirect = rp.takeCallback(flow.state);
  if (!redirect) throw new Error('The authorization callback was not received.');
  return { flow, redirect };
}

function profileStatus(page: Page) {
  return page.evaluate(async () => (await fetch('/api/me')).status);
}

async function serverSession(page: Page, rp: RP) {
  const cookie = (await page.context().cookies(rp.spec.origin)).find((row) => row.name === loginCookie);
  const session = cookie && rp.session(cookie.value);
  if (!session) throw new Error('The relying party did not establish a session.');
  return session;
}

async function readKeys(issuer: string) {
  const metadata = await fetch(`${issuer}/.well-known/openid-configuration`).then((r) => r.json()) as { jwks_uri: string };
  const keys = await fetch(metadata.jwks_uri).then((r) => r.json()) as { keys: JWK[] };
  return keys.keys;
}

test('provisioned accounts and clients survive restart with real OIDC, revocation and key rotation', async ({ page, context }) => {
  const database = process.env.IDENTITY_ACCEPTANCE_DATABASE_URL;
  if (!database || new URL(database).pathname !== '/identity_lab') {
    throw new Error('Set IDENTITY_ACCEPTANCE_DATABASE_URL to the dedicated identity_lab database.');
  }
  const scope = `identity_service_${randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString: database });
  const databaseScoped = new URL(database);
  databaseScoped.searchParams.set('options', `-c search_path=${scope}`);
  const directory = await mkdtemp(join(tmpdir(), 'niltavi-identity-service-'));
  const port = Number(process.env.IDENTITY_ACCEPTANCE_PORT ?? '43720');
  const issuer = `https://${hosts[0]}:${port}`;
  const email = 'acceptance@example.test';
  const pass = `identity-test-${randomBytes(12).toString('hex')}`;
  const newPass = `identity-recovery-${randomBytes(12).toString('hex')}`;
  const aSpec = createClient('app-a', port + 1);
  const bSpec = createClient('app-b', port + 2);
  const fixtureFile = (name: string) => {
    const file = process.env[name];
    if (!file) throw new Error(`Set ${name} for the strict TLS profile.`);
    return readFile(file, 'utf8');
  };
  const certificate = strictSeed ? { cert: await fixtureFile('IDENTITY_LOCAL_CERT'), private: await fixtureFile('IDENTITY_LOCAL_KEY') }
    : await selfsigned.generate([{ name: 'commonName', value: hosts[0] }], {
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: hosts.map((value) => ({ type: 2, value })) },
    ],
    });
  const ca = strictSeed ? await fixtureFile('IDENTITY_LOCAL_CA') : certificate.cert;
  const certPath = join(directory, 'tls.crt');
  const keyPath = join(directory, 'tls.key');
  const caPath = join(directory, 'ca.crt');
  const passwordPath = join(directory, 'password');
  const env = { ...process.env,
    IDENTITY_DATABASE_URL: databaseScoped.href,
    IDENTITY_SECRETS_DIR: join(directory, 'secrets'),
    IDENTITY_PORT: String(port),
    IDENTITY_HOST: '127.0.0.1',
    IDENTITY_ISSUER: issuer,
    IDENTITY_TLS_CERT_FILE: certPath,
    IDENTITY_TLS_KEY_FILE: keyPath,
    IDENTITY_LOOPBACK_CA_FILE: caPath,
    IDENTITY_PASSWORD_FILE: passwordPath,
  };
  const tls = { cert: certificate.cert, key: certificate.private };
  const previousDispatcher = getGlobalDispatcher();
  const agent = new Agent({ connect: { ca, lookup(host, options, cb) {
    if (!(hosts as readonly string[]).includes(host)) cb(new Error('Unexpected acceptance host.'), '', 4);
    else if (options.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
    else cb(null, '127.0.0.1', 4);
  } } });
  setGlobalDispatcher(agent);
  const rps: RP[] = [];
  let child: ReturnType<typeof spawn> | undefined;
  async function stop() {
    const process = child;
    child = undefined;
    if (process && process.exitCode === null && process.signalCode === null) {
      const exited = once(process, 'exit');
      process.kill();
      await exited;
    }
  }
  async function start() {
    let startupError = '';
    child = spawn(process.execPath, ['dist/cli.js', 'serve'], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr?.on('data', (chunk: Buffer) => { startupError = (startupError + chunk.toString()).slice(-1000); });
    await expect.poll(async () => {
      if (child?.exitCode !== null) throw new Error(`The service exited before becoming ready. ${startupError.trim()}`);
      return fetch(`${issuer}/healthz`, { signal: AbortSignal.timeout(1_000) }).then((r) => r.status).catch(() => 0);
    }).toBe(200);
  }
  async function cli<T>(...args: string[]): Promise<T> {
    const { stdout } = await execute(process.execPath, ['dist/cli.js', ...args], { env, windowsHide: true });
    return JSON.parse(stdout) as T;
  }
  async function register(spec: typeof aSpec) {
    const result = await cli<{ client_secret: string }>('application', 'register', spec.id, spec.callback, spec.postLogout, spec.backchannelLogout, spec.resource);
    spec.secret = result.client_secret;
  }
  let accountId = '';
  try {
    await admin.query(`CREATE SCHEMA "${scope}"`);
    await Promise.all([
      writeFile(certPath, certificate.cert),
      writeFile(caPath, ca),
      writeFile(keyPath, certificate.private, { mode: 0o600 }),
      writeFile(passwordPath, pass, { mode: 0o600 }),
    ]);
    await test.step('Provision through the operator CLI and reject repeats/invalid registration', async () => {
      await expect(cli('migrate')).resolves.toEqual({ version: 2, changed: true });
      await expect(cli('migrate')).resolves.toEqual({ version: 2, changed: false });
      await cli('keys', 'init');
      await expect(cli('keys', 'init')).rejects.toThrow('already exists');
      accountId = (await cli<{ id: string }>('account', 'create', email)).id;
      await expect(cli('account', 'create', email.toUpperCase())).rejects.toThrow('already uses');
      await expect(cli('application', 'register', aSpec.id,
        aSpec.callback, aSpec.postLogout, aSpec.backchannelLogout, bSpec.resource)).rejects.toThrow('same origin');
      await register(aSpec);
      await register(bSpec);
      await expect(register(aSpec)).rejects.toThrow('already uses');
    });
    await start();
    const a = await buildRelyingParty(aSpec, issuer, tls);
    const b = await buildRelyingParty(bSpec, issuer, tls);
    rps.push(a, b);
    await Promise.all(rps.map((rp) => rp.app.listen({ host: '127.0.0.1', port: rp.spec.port })));
    const other = await context.newPage();

    await test.step('Reject invalid interactions, cross-client introspection and incorrect passwords', async () => {
      expect((await fetch(`${issuer}/interaction/invalid`)).status).toBe(400);
      expect((await fetch(`${issuer}/interaction/invalid`, { method: 'POST' })).status).toBe(403);
      const invalid = (await a.authorize()).url;
      invalid.searchParams.set('redirect_uri', `${aSpec.callback}?unregistered=yes`);
      expect((await page.goto(invalid.href))?.status()).toBe(400);
      const noPkce = (await a.authorize()).url;
      noPkce.searchParams.delete('code_challenge');
      noPkce.searchParams.delete('code_challenge_method');
      await page.goto(noPkce.href);
      expect(new URL(page.url()).searchParams.get('error')).toBe('invalid_request');
      await authorize(page, a);
      await credentials(page, email, 'wrong test password');
      await expect(page.getByText('Credentials were not accepted.')).toBeVisible();
      await credentials(page, email, pass);
      await expectLogin(page, a);
      const token = await serverSession(page, a);
      expect((await a.introspect(token.accessToken)).active).toBe(true);
      expect((await b.introspect(token.accessToken)).active).toBe(false);
    });

    await test.step('Keep the issuer, client, account and center session across provider restart', async () => {
      const initial = await readKeys(issuer);
      expect(initial.every((jwk) => jwk.d === undefined)).toBe(true);
      await stop();
      await start();
      expect(await readKeys(issuer)).toEqual(initial);
      await expect(cli('account', 'show', email)).resolves.toMatchObject({ id: accountId, enabled: true });
      expect(await profileStatus(page)).toBe(200);
      await authorize(other, b);
      await expectLogin(other, b);
      expect(b.callbackSite).toBe('cross-site');
      expect((await serverSession(other, b)).sub).toBe(accountId);
    });

    await test.step('Only one concurrent authorization-code and one concurrent refresh exchange succeed', async () => {
      const { flow, redirect } = await issueCode(await context.newPage(), a);
      const once = await Promise.allSettled([a.exchange(redirect, flow), a.exchange(redirect, flow)]);
      expect(once.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(once.find((r) => r.status === 'rejected')).toMatchObject({ reason: { error: 'invalid_grant' } });
      const session = await serverSession(other, b);
      const refresh = await Promise.allSettled([b.refresh(session.refreshToken), b.refresh(session.refreshToken)]);
      expect(refresh.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(refresh.find((r) => r.status === 'rejected')).toMatchObject({ reason: { error: 'invalid_grant' } });
    });

    await test.step('Disable and re-enable via CLI, then recover access with a new password', async () => {
      // Code replay may revoke its application grant. Verify the disable step
      // starts with both RPs newly authorized under the center session.
      if (await profileStatus(page) !== 200) {
        await authorize(page, a);
        await expectLogin(page, a);
      }
      if (await profileStatus(other) !== 200) {
        await authorize(other, b);
        await expectLogin(other, b);
      }
      expect(await profileStatus(page)).toBe(200);
      expect(await profileStatus(other)).toBe(200);
      const old = await serverSession(page, a);
      const pending = await issueCode(await context.newPage(), b);
      expect(await cli('account', 'disable', email)).toMatchObject({ enabled: false, changed: true });
      const stopped = performance.now();
      expect(await cli('account', 'disable', email)).toMatchObject({ enabled: false, changed: false });
      expect(await profileStatus(page)).toBe(401);
      expect(await profileStatus(other)).toBe(401);
      expect(performance.now() - stopped).toBeLessThan(30_000);
      await expect(a.refresh(old.refreshToken)).rejects.toMatchObject({ error: 'invalid_grant' });
      await expect(b.exchange(pending.redirect, pending.flow)).rejects.toMatchObject({ error: 'invalid_grant' });
      await authorize(page, a);
      await credentials(page, email, pass);
      await expect(page.getByText('Credentials were not accepted.')).toBeVisible();
      expect(await cli('account', 'enable', email)).toMatchObject({ enabled: true, changed: true });
      expect((await a.introspect(old.accessToken)).active).toBe(false);
      await credentials(page, email, pass);
      await expectLogin(page, a);
      await authorize(other, b);
      await expectLogin(other, b);
      expect(await profileStatus(page)).toBe(200);
      expect(await profileStatus(other)).toBe(200);
      await writeFile(passwordPath, newPass, { mode: 0o600 });
      expect(await cli('account', 'reset-password', email)).toMatchObject({ enabled: true });
      expect(await profileStatus(page)).toBe(401);
      expect(await profileStatus(other)).toBe(401);
      await authorize(page, a);
      await credentials(page, email, pass);
      await expect(page.getByText('Credentials were not accepted.')).toBeVisible();
      await credentials(page, email, newPass);
      await expectLogin(page, a);
      await authorize(other, b);
      await expectLogin(other, b);
      const events = await cli<Array<{ action: string }>>('audit', 'list');
      expect(events.map((event) => event.action)).toEqual([
        'account.created', 'application.registered', 'application.registered', 'account.disabled', 'account.enabled', 'account.password_reset',
      ]);
    });

    await test.step('Perform healthy global logout and verify that both apps deny access in five seconds', async () => {
      await page.goto(aSpec.origin);
      await page.getByRole('button', { name: 'Sign out of all apps' }).click();
      const started = performance.now();
      await page.getByRole('button', { name: 'End session' }).click();
      await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
      expect(await profileStatus(page)).toBe(401);
      expect(await profileStatus(other)).toBe(401);
      expect([a.logoutCount, b.logoutCount]).toEqual([1, 1]);
      expect(performance.now() - started).toBeLessThan(5_000);
    });

    await test.step('Reject an old RP token even when its back-channel receipt fails', async () => {
      await authorize(page, a);
      await credentials(page, email, newPass);
      await expectLogin(page, a);
      await authorize(other, b);
      await expectLogin(other, b);
      const prior = await serverSession(other, b);
      b.setLogoutReceiverAvailable(false);
      await page.getByRole('button', { name: 'Sign out of all apps' }).click();
      await page.getByRole('button', { name: 'End session' }).click();
      await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
      expect((await b.introspect(prior.accessToken)).active).toBe(false);
      expect(await profileStatus(other)).toBe(401);
      expect(b.logoutCount).toBe(1);
      b.setLogoutReceiverAvailable(true);
    });

    await test.step('Stage, publish and activate a new signing key while the old signature remains valid', async () => {
      await authorize(page, a);
      await credentials(page, email, newPass);
      await expectLogin(page, a);
      const before = (await serverSession(page, a)).idToken;
      const oldKid = decodeProtectedHeader(before).kid;
      const pending = await cli<{ kid: string; changed: boolean }>('keys', 'stage');
      expect(await cli('keys', 'stage')).toEqual({ kid: pending.kid, changed: false });
      await stop();
      await start();
      let keys = await readKeys(issuer);
      expect(keys.map((key) => key.kid)).toEqual(expect.arrayContaining([oldKid, pending.kid]));
      await expect(cli('keys', 'activate', 'unknown')).rejects.toThrow('Stage and publish');
      await cli('keys', 'activate', pending.kid);
      expect(await cli('keys', 'activate', pending.kid)).toEqual({ kid: pending.kid, changed: false });
      await stop();
      await start();
      keys = await readKeys(issuer);
      const old = keys.find((key) => key.kid === oldKid);
      if (!old) throw new Error('The retirement window is missing the old key.');
      await jwtVerify(before, await importJWK(old, 'RS256'), { issuer, audience: aSpec.id });
      await authorize(other, b);
      await expectLogin(other, b);
      expect(decodeProtectedHeader((await serverSession(other, b)).idToken).kid).toBe(pending.kid);
    });
  } finally {
    await stop();
    await Promise.allSettled(rps.map((rp) => rp.app.close()));
    setGlobalDispatcher(previousDispatcher);
    await agent.close();
    await admin.query(`DROP SCHEMA IF EXISTS "${scope}" CASCADE`).finally(() => admin.end());
    await rm(directory, { recursive: true, force: true });
  }
});
