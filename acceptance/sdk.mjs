// End-to-end proof of the integration SDK: Identity runs in this process on a throwaway
// PostgreSQL schema, three copies of the example application run beside it, and every
// assertion is made with real HTTPS requests, the way a browser or an agent would make them.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { SignJWT, importJWK } from 'jose';
import selfsigned from 'selfsigned';
import { Agent } from 'undici';
import {
  connect, createAccount, migrate, registerApplication, schemaVersion, setAccountEnabled, setApplicationEnabled, setInstanceRole,
  standardApplication,
} from '../dist/database.js';
import { service } from '../dist/service.js';
import { initializeSecrets, loadKeyRing, loadSecretEncryptionKey } from '../dist/settings.js';
import { DEFAULT_CHECK_INTERVAL_SECONDS, DEFAULT_OUTAGE_GRACE_SECONDS, UNAVAILABLE_MESSAGE, createIdentity } from '../sdk/dist/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const db = new URL(process.env.IDENTITY_ACCEPTANCE_DATABASE_URL ?? 'postgresql://identity_lab:identity_lab@127.0.0.1:55450/identity_lab');
assert.equal(db.pathname, '/identity_lab');
const schema = `identity_sdk_${randomBytes(8).toString('hex')}`;
const dbAdmin = connect(db.href);
db.searchParams.set('options', `-c search_path=${schema}`);
const pool = connect(db.href);
const files = await mkdtemp(join(tmpdir(), 'identity-sdk-'));
const base = Number(process.env.IDENTITY_SDK_TEST_PORT ?? 43950);
const issuer = `https://identity.localhost:${base}`;
// A and B check their sessions every few seconds so the run stays short. C keeps the shipped
// 60 seconds and 5 minutes, so anything that reaches C quickly arrived as a notification.
// B's notification address is unreachable, so everything B learns comes from its own checks.
const check = 3;
const grace = 9;
const apps = {
  a: { id: 'flagstone-demo', name: 'Flagstone Demo', host: 'flagstone.localhost', port: base + 1, noun: 'task', deep: '/tasks/42', fast: true },
  b: { id: 'wattlework-demo', name: 'Wattlework Demo', host: 'wattlework.localhost', port: base + 2, noun: 'contract', deep: '/contracts/7', fast: true },
  c: { id: 'plainstone-demo', name: 'Plainstone Demo', host: 'plainstone.localhost', port: base + 3, noun: 'task', deep: '/tasks/9', fast: false },
};
// D is not the example application: it is a Fastify server in this process, to prove the SDK on Fastify's raw objects.
apps.d = { id: 'fernbank-demo', name: 'Fernbank Demo', host: 'fernbank.localhost', port: base + 4 };
for (const app of Object.values(apps)) app.origin = `https://${app.host}:${app.port}`;
const { a, b, c, d } = apps;

const hosts = ['identity.localhost', ...Object.values(apps).map(({ host }) => host)];
const cert = await selfsigned.generate([{ name: 'commonName', value: 'identity.localhost' }], {
  algorithm: 'sha256',
  extensions: [{ name: 'basicConstraints', cA: false }, { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [...hosts.map((value) => ({ type: 2, value })), { type: 7, ip: '127.0.0.1' }] }],
});
const crt = join(files, 'cert.pem');
const key = join(files, 'key.pem');
await Promise.all([writeFile(crt, cert.cert), writeFile(key, cert.private)]);
Object.assign(process.env, { IDENTITY_ISSUER: issuer, IDENTITY_PORT: String(base), IDENTITY_HOST: '127.0.0.1',
  IDENTITY_TLS_CERT_FILE: crt, IDENTITY_TLS_KEY_FILE: key, IDENTITY_SECRETS_DIR: join(files, 'secrets'),
  IDENTITY_LOOPBACK_CA_FILE: crt, NODE_EXTRA_CA_CERTS: crt });

function lookup(_host, options, done) {
  if (options.all) done(null, [{ address: '127.0.0.1', family: 4 }]);
  else done(null, '127.0.0.1', 4);
}

// One browser profile: a cookie jar per host. It follows redirects itself, and types a
// password into Identity's sign-in form only when it was given one.
class Browser {
  cookies = new Map();

  request(url, { method = 'GET', headers = {}, json, form } = {}) {
    const target = new URL(url);
    const jar = this.cookies.get(target.hostname);
    const body = json !== undefined ? JSON.stringify(json) : form !== undefined ? new URLSearchParams(form).toString() : undefined;
    return new Promise((resolve, reject) => {
      const outgoing = https.request(target, { method: body === undefined ? method : 'POST', ca: cert.cert, lookup, headers: {
        accept: 'text/html', 'accept-language': 'en', ...(jar?.size ? { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
        ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body),
          'content-type': json !== undefined ? 'application/json' : 'application/x-www-form-urlencoded' }), ...headers,
      } }, async (response) => {
        try {
          let text = '';
          for await (const chunk of response.setEncoding('utf8')) text += chunk;
          const stored = this.cookies.get(target.hostname) ?? new Map();
          this.cookies.set(target.hostname, stored);
          for (const line of response.headers['set-cookie'] ?? []) {
            const pair = line.split(';', 1)[0];
            const split = pair.indexOf('=');
            if (!pair.slice(split + 1) || /max-age=0(;|$)/i.test(line)) stored.delete(pair.slice(0, split));
            else stored.set(pair.slice(0, split), pair.slice(split + 1));
          }
          let data;
          try { data = JSON.parse(text); } catch { /* Not every answer is JSON. */ }
          resolve({ url: target.href, status: response.statusCode, headers: response.headers, text, data,
            location: response.headers.location ? new URL(response.headers.location, target).href : undefined });
        } catch (error) { reject(error); }
      });
      outgoing.setTimeout(15_000, () => outgoing.destroy(new Error(`No answer from ${target.href}.`)));
      outgoing.on('error', reject);
      outgoing.end(body);
    });
  }

  api(url, headers = {}) {
    return this.request(url, { headers: { accept: 'application/json', ...headers } });
  }

  // Identity's own account API: same-origin JSON.
  account(path, json) {
    return this.request(issuer + path, json === undefined ? { headers: { accept: 'application/json' } }
      : { json, headers: { origin: issuer, accept: 'application/json' } });
  }

  async go(url, credentials) {
    const hops = [];
    let typed = 0;
    let response = await this.request(url);
    for (let count = 0; count < 25; count += 1) {
      const redirected = response.status >= 300 && response.status < 400 && response.location;
      const signIn = credentials && response.status === 200 && /^\/interaction\/[\w-]+$/.test(new URL(response.url).pathname);
      if (!redirected && !signIn) return { final: response, hops, typed };
      hops.push(response);
      if (signIn) typed += 1;
      response = redirected ? await this.request(response.location)
        : await this.request(response.url, { form: credentials, headers: { origin: issuer } });
    }
    throw new Error(`Too many redirects from ${url}.`);
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
// Polls until the condition holds and returns how long that took.
async function within(ms, label, condition) {
  const started = Date.now();
  let last;
  while (Date.now() - started <= ms) {
    last = await condition();
    if (last === true) return Date.now() - started;
    await sleep(150);
  }
  assert.fail(`${label}: not within ${ms} ms (last saw ${JSON.stringify(last)})`);
}
const status = (browser, url, expected, headers) => async () => {
  const answer = await browser.api(url, headers);
  return answer.status === expected || answer.status;
};
const polled = (check + 2.5) * 1_000;
const notified = 2_500;
const password = () => `sdk-${randomBytes(18).toString('hex')}`;
const step = (message) => console.log(`ok  ${message}`);

const children = [];
function startApp(app, secret, extra = {}) {
  const child = spawn(process.execPath, ['examples/minimal-app/server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, NILTAVI_IDENTITY_ISSUER: issuer, NILTAVI_APP_ID: app.id, NILTAVI_APP_SECRET: secret, PORT: String(app.port),
    APP_HOST: app.host, APP_NOUN: app.noun, APP_TLS_CERT_FILE: crt, APP_TLS_KEY_FILE: key,
    ...(app.fast ? { APP_TEST_CHECK_SECONDS: String(check), APP_TEST_GRACE_SECONDS: String(grace) } : {}), ...extra } });
  child.output = '';
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', (chunk) => { child.output += chunk; });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`${app.name} stopped (${code}).\n${child.output}`)));
    child.stdout.on('data', () => { if (child.output.includes(`${app.origin}${app.noun === 'task' ? '/tasks/42' : '/contracts/7'}`)) resolve(child); });
  });
}

let identity;
let fastify;
let trusting;
let failed = true;
try {
  await dbAdmin.query(`CREATE SCHEMA "${schema}"`);
  await initializeSecrets(process.env.IDENTITY_SECRETS_DIR);
  assert.deepEqual(await migrate(pool), { version: schemaVersion, changed: true });
  const encryptionKey = await loadSecretEncryptionKey(process.env.IDENTITY_SECRETS_DIR);
  const secrets = {};
  for (const app of Object.values(apps)) {
    secrets[app.id] = (await registerApplication(pool, encryptionKey, standardApplication(app.id, app.name, `${app.origin}/`))).client_secret;
  }
  await pool.query('UPDATE applications SET backchannel_logout = $2 WHERE id = $1', [b.id, `https://${b.host}:${base + 9}/auth/notifications`]);

  const owner = { email: 'olive@harbour.example.test', password: password() };
  const member = { email: 'mabel@harbour.example.test', password: password() };
  const tester = { email: 'selftest@harbour.example.test', password: password() };
  owner.id = (await createAccount(pool, owner.email, owner.password)).id;
  member.id = (await createAccount(pool, member.email, member.password)).id;
  await createAccount(pool, tester.email, tester.password);
  await setInstanceRole(pool, owner.email, true);
  identity = await service(pool);
  await Promise.all([startApp(a, secrets[a.id], { APP_PEER_ID: b.id, APP_PEER_URL: b.origin }), startApp(b, secrets[b.id]), startApp(c, secrets[c.id])]);

  // The shipped behaviour is a check every 60 seconds and 5 minutes of grace. Only tests shorten it.
  assert.equal(DEFAULT_CHECK_INTERVAL_SECONDS, 60);
  assert.equal(DEFAULT_OUTAGE_GRACE_SECONDS, 300);
  // The applications trust the test certificate through NODE_EXTRA_CA_CERTS. This process started before it existed.
  trusting = new Agent({ connect: { ca: cert.cert, lookup } });
  const viaTestCa = (url, init) => fetch(url, { ...init, dispatcher: trusting });
  const plain = await createIdentity({ issuer, appId: c.id, appSecret: secrets[c.id], fetch: viaTestCa });
  assert.deepEqual(plain.settings, { cookieName: '__Host-plainstone-demo-session', sessionSeconds: 43_200, checkIntervalSeconds: 60, outageGraceSeconds: 300 });
  assert.deepEqual(plain.app, { id: c.id, name: c.name, origin: c.origin, homeUrl: `${c.origin}/` });
  plain.close();
  await assert.rejects(createIdentity({ issuer, appId: c.id, appSecret: 'wrong', fetch: viaTestCa }), /did not accept/);
  step('three settings are enough: endpoints and registered URLs are discovered, defaults are 60 s and 5 min');

  const ownerBrowser = new Browser();
  assert.equal((await ownerBrowser.account('/account/login', { email: owner.email, password: owner.password })).status, 204);
  const team = (await ownerBrowser.account('/account/orgs', { name: 'Harbour Team' })).data;
  assert.ok(team.id);
  await pool.query("INSERT INTO memberships (org_id, account_id, role) VALUES ($1, $2, 'admin')", [team.id, member.id]);

  // (a) No session anywhere: the deep link leads to sign-in and straight back.
  const mabel = new Browser();
  const credentials = { email: member.email, password: member.password };
  let visit = await mabel.go(a.origin + a.deep, credentials);
  assert.equal(visit.final.url, a.origin + a.deep);
  assert.equal(visit.final.status, 200);
  assert.equal(visit.typed, 1);
  assert.match(visit.final.text, /mabel@harbour\.example\.test \(not verified\)/);
  assert.match(visit.final.text, /Harbour Team<\/td><td>Admin<\/td><td>Current team/);
  assert.ok(visit.final.text.includes(member.id));
  for (const label of ['Sign out of Flagstone Demo only', 'Sign out of all Niltavi apps in this browser', 'Sign out on all devices']) {
    assert.ok(visit.final.text.includes(label), label);
  }
  const authorize = new URL(visit.hops[0].location);
  assert.equal(authorize.origin, issuer);
  assert.equal(authorize.searchParams.get('ui_locales'), 'en');
  assert.ok(!visit.hops[0].location.includes('tasks'), 'the page to return to stays on the application side');
  const sessionCookie = visit.hops.find(({ url }) => url.startsWith(`${a.origin}/auth/callback?`)).headers['set-cookie']
    .find((line) => line.startsWith('__Host-flagstone-demo-session='));
  assert.match(sessionCookie, /^__Host-flagstone-demo-session=[\w-]{43}; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax$/);
  const chinese = await new Browser().request(a.origin + a.deep, { headers: { 'accept-language': 'zh-CN,zh;q=0.9' } });
  assert.equal(new URL(chinese.location).searchParams.get('ui_locales'), 'zh-CN');
  step('deep link → sign-in → the same deep link, for an account with no session');

  // (b) The browser already has a central session: the second application opens with no input.
  visit = await mabel.go(b.origin + b.deep);
  assert.equal(visit.final.url, b.origin + b.deep);
  assert.equal(visit.final.status, 200);
  assert.ok(visit.hops.every(({ status: code }) => code >= 300 && code < 400), 'no page in between');
  assert.equal((await mabel.go(c.origin + c.deep)).final.url, c.origin + c.deep);
  const me = {};
  for (const app of [a, b, c]) {
    const answer = await mabel.api(`${app.origin}/api/me`);
    assert.equal(answer.status, 200);
    me[app.id] = answer.data;
  }
  assert.equal(me[a.id].sub, member.id);
  assert.equal(me[a.id].issuer, issuer);
  assert.equal(me[a.id].kind, 'session');
  assert.deepEqual(me[b.id], me[a.id]);
  assert.deepEqual(me[c.id], me[a.id]);
  assert.deepEqual(me[a.id].teams.map(({ name, role, personal }) => ({ name, role, personal })),
    [{ name: 'Personal', role: 'owner', personal: true }, { name: 'Harbour Team', role: 'admin', personal: false }]);
  assert.equal(me[a.id].team.id, team.id);
  assert.equal((await new Browser().api(`${a.origin}/api/me`)).status, 401);
  step('a browser with a central session opens the second application with zero input; same sub and teams in every application');

  // The same SDK on Fastify: /auth/* in an onRequest hook, guards as preHandlers, both on the raw objects.
  const onFastify = await createIdentity({ issuer, appId: d.id, appSecret: secrets[d.id], fetch: viaTestCa });
  fastify = Fastify({ https: { cert: cert.cert, key: cert.private } });
  fastify.addHook('onClose', () => onFastify.close());
  fastify.addHook('onRequest', async (request, reply) => {
    if (!await onFastify.handle(request.raw, reply.raw)) return undefined;
    reply.hijack();
    return reply;
  });
  const guarded = (guard) => async (request, reply) => {
    request.user = await guard(request.raw, reply.raw);
    if (request.user) return undefined;
    reply.hijack();
    return reply;
  };
  fastify.get('/private/:id', { preHandler: guarded(onFastify.requireLogin()) }, async (request) => ({ id: request.params.id, sub: request.user.sub }));
  fastify.get('/admin', { preHandler: guarded(onFastify.requireRole('owner', { api: true })) }, async () => ({ admin: true }));
  await fastify.listen({ host: '127.0.0.1', port: d.port });
  visit = await mabel.go(`${d.origin}/private/5?view=full`);
  assert.equal(visit.final.url, `${d.origin}/private/5?view=full`);
  assert.deepEqual(visit.final.data, { id: '5', sub: member.id });
  assert.equal((await mabel.api(`${d.origin}/admin`)).status, 403);
  assert.equal((await new Browser().api(`${d.origin}/private/5`)).status, 401);
  assert.equal((await mabel.request(`${d.origin}/auth/logout`, { form: { scope: 'app' }, headers: { origin: d.origin } })).headers.location, '/auth/signed-out');
  assert.equal((await mabel.api(`${d.origin}/private/5`)).status, 401);
  step('the SDK serves the same routes and guards on Fastify raw objects');

  // (c) A new person registers from the sign-in page and lands on the deep link, with no page in between.
  const newcomer = new Browser();
  visit = await newcomer.go(a.origin + a.deep);
  assert.match(new URL(visit.final.url).pathname, /^\/interaction\/[\w-]+$/);
  const registrationPath = new URL(visit.final.url).pathname + '/register';
  const register = await newcomer.request(issuer + registrationPath);
  assert.ok(register.status === 200 || register.status === 303);
  const created = await newcomer.account(registrationPath, { email: 'nell@harbour.example.test', password: password() });
  assert.equal(created.status, 201);
  assert.match(created.data.continueTo, /^\/interaction\/[\w-]+\/registered$/);
  visit = await newcomer.go(issuer + created.data.continueTo);
  assert.equal(visit.final.url, a.origin + a.deep);
  assert.equal(visit.final.status, 200);
  assert.ok(visit.hops.every(({ status: code }) => code >= 300 && code < 400), 'no page in between');
  assert.equal((await newcomer.api(`${a.origin}/api/me`)).data.email, 'nell@harbour.example.test');
  step('a new account registers from the sign-in page and lands on the same deep link');

  // The current team and its switcher.
  const personal = me[a.id].teams[0];
  assert.equal((await mabel.request(`${a.origin}/settings`)).status, 200);
  assert.equal((await mabel.request(`${a.origin}/auth/team`, { form: { org_id: personal.id, return_to: a.deep } })).status, 403);
  let switched = await mabel.request(`${a.origin}/auth/team`, { form: { org_id: personal.id, return_to: '//attacker.example/' }, headers: { origin: a.origin } });
  assert.equal(switched.status, 303);
  assert.equal(switched.headers.location, '/');
  assert.equal((await mabel.api(`${a.origin}/api/me`)).data.team.id, personal.id);
  assert.equal((await mabel.request(`${a.origin}/auth/team`, { form: { org_id: randomUUID() }, headers: { origin: a.origin } })).status, 403);
  switched = await mabel.request(`${a.origin}/auth/team`, { form: { org_id: team.id, return_to: a.deep }, headers: { origin: a.origin } });
  assert.equal(switched.headers.location, a.deep);
  assert.equal((await mabel.api(`${a.origin}/api/me`)).data.team.id, team.id);
  step('the current team is switched from the application, by a member only, from the application\'s own pages only');

  // Agent access tokens: the same account and team as a browser sign-in, for one application.
  const issue = async (name, org = team.id) => {
    const answer = await mabel.account('/account/tokens', { name, app: b.id, org, days: '' });
    assert.equal(answer.status, 201);
    return answer.data;
  };
  const agent = await issue('Build agent');
  const spare = await issue('Spare agent');
  const bearer = (token) => ({ authorization: `Bearer ${token}` });
  const anyone = new Browser();
  const asAgent = await anyone.api(`${b.origin}/api/me`, bearer(agent.token));
  assert.equal(asAgent.status, 200);
  assert.deepEqual({ ...asAgent.data, kind: 'session', tokenId: null, teams: me[b.id].teams }, me[b.id]);
  assert.deepEqual(asAgent.data.teams, [me[b.id].team]);
  assert.equal(asAgent.data.tokenId, agent.id);
  assert.equal((await anyone.api(`${a.origin}/api/me`, bearer(agent.token))).status, 401);
  assert.equal((await anyone.api(`${b.origin}/api/me`, bearer(`nvt_${'A'.repeat(43)}`))).status, 401);
  assert.equal((await anyone.api(`${b.origin}/settings`, bearer(agent.token))).status, 200);
  assert.equal((await mabel.account(`/account/tokens/${agent.id}/revoke`, {})).status, 204);
  await within(polled, 'revoked Agent token', status(anyone, `${b.origin}/api/me`, 401, bearer(agent.token)));
  step('an Agent token gives the same sub and team, is refused by another application, and stops working after it is revoked');

  // Service tokens: one application proves itself to another.
  const peer = await mabel.api(`${a.origin}/api/peer`);
  assert.deepEqual(peer.data, { status: 200, peer: { app: b.id, caller: a.id } });
  const basic = (app) => ({ authorization: `Basic ${Buffer.from(`${app.id}:${secrets[app.id]}`).toString('base64')}` });
  const elsewhere = await anyone.request(`${issuer}/apps/service-token`, { json: { audience: c.id }, headers: basic(a) });
  assert.equal(elsewhere.status, 200);
  const whoami = `${b.origin}/api/service/whoami`;
  assert.equal((await anyone.api(whoami, bearer(elsewhere.data.access_token))).status, 401);
  assert.equal((await anyone.api(whoami)).status, 401);
  assert.equal((await anyone.api(whoami, bearer('garbled.token.value'))).status, 401);
  const signing = (await loadKeyRing(process.env.IDENTITY_SECRETS_DIR)).keys[0];
  const signingKey = await importJWK(signing, 'RS256');
  const serviceToken = (expires, audience = b.id) => new SignJWT({ client_id: a.id, scope: 'service' })
    .setProtectedHeader({ alg: 'RS256', kid: signing.kid, typ: 'at+jwt' }).setIssuer(issuer).setSubject(a.id).setAudience(audience)
    .setIssuedAt(Math.floor(Date.now() / 1_000) - 600).setJti(randomUUID()).setExpirationTime(Math.floor(Date.now() / 1_000) + expires).sign(signingKey);
  assert.deepEqual((await anyone.api(whoami, bearer(await serviceToken(120)))).data, { app: b.id, caller: a.id });
  assert.equal((await anyone.api(whoami, bearer(await serviceToken(-120)))).status, 401);
  assert.equal((await anyone.api(whoami, bearer(await serviceToken(120, c.id)))).status, 401);
  const real = (await anyone.request(`${issuer}/apps/service-token`, { json: { audience: b.id }, headers: basic(a) })).data.access_token;
  assert.equal((await anyone.api(whoami, bearer(`${real.slice(0, -6)}AAAAAA`))).status, 401);
  step('a service token from one application is accepted by the one it is addressed to, and refused when expired, garbled or addressed elsewhere');

  // Notifications are accepted only when Identity signed them for this application, recently, once.
  const notice = (event, { audience = a.id, age = 0, sub = randomUUID(), type = 'logout+jwt' } = {}) => new SignJWT({ events: { [event]: {} } })
    .setProtectedHeader({ alg: 'RS256', kid: signing.kid, typ: type }).setIssuer(issuer).setAudience(audience).setSubject(sub)
    .setIssuedAt(Math.floor(Date.now() / 1_000) - age).setJti(randomUUID()).setExpirationTime(Math.floor(Date.now() / 1_000) - age + 120).sign(signingKey);
  const deliver = async (token) => (await anyone.request(`${a.origin}/auth/notifications`, { form: { logout_token: token } })).status;
  const logoutEvent = 'http://schemas.openid.net/event/backchannel-logout';
  const membershipEvent = 'https://niltavi.com/events/membership-changed';
  const genuine = await notice(membershipEvent);
  assert.equal(await deliver(genuine), 200);
  assert.equal(await deliver(genuine), 400, 'a replayed notification');
  assert.equal(await deliver(await notice(logoutEvent, { audience: b.id, sub: member.id })), 400, 'a notification for another application');
  assert.equal(await deliver(await notice(logoutEvent, { age: 900, sub: member.id })), 400, 'a stale notification');
  assert.equal(await deliver(await notice(logoutEvent, { type: 'at+jwt', sub: member.id })), 400, 'a token of another type');
  assert.equal(await deliver(await notice('https://example.test/unknown', { sub: member.id })), 400, 'an unknown event');
  assert.equal(await deliver(await serviceToken(120, a.id)), 400, 'a service token');
  assert.equal((await mabel.api(`${a.origin}/api/me`)).status, 200);
  step('notifications are verified: replayed, stale, mistyped and wrong-audience tokens are refused');

  // The self-test an integrator runs against their own application.
  const selftest = spawn(process.execPath, ['sdk/selftest.mjs', '--app', a.origin, '--page', a.deep, '--api', '/api/me', '--ca', crt], {
    cwd: root, stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, NILTAVI_SELFTEST_EMAIL: tester.email, NILTAVI_SELFTEST_PASSWORD: tester.password } });
  let report = '';
  selftest.stdout.setEncoding('utf8').on('data', (chunk) => { report += chunk; });
  const [selftestCode] = await once(selftest, 'exit');
  console.log(report.trimEnd().replaceAll(/^/gm, '    '));
  assert.equal(selftestCode, 0, 'the self-test passes against the example application');
  assert.equal(report.match(/^PASS /gm)?.length, 12);
  step('the self-test passes: open redirects, wrong state, replayed callback, cookie flags, forged notifications, cross-site sign-out');

  // A role change reaches every application: at once where the notification arrives, and
  // within one check interval where it does not.
  for (const app of [a, b, c]) assert.equal((await mabel.api(`${app.origin}/settings`)).status, 200);
  const membership = `/account/orgs/${team.id}/members/${member.id}`;
  assert.deepEqual((await ownerBrowser.account(`${membership}/role`, { role: 'member' })).data, { changed: true });
  await within(notified, 'role change by notification, default intervals', status(mabel, `${c.origin}/settings`, 403));
  await within(notified, 'role change by notification', status(mabel, `${a.origin}/settings`, 403));
  await within(polled, 'role change without notifications', status(mabel, `${b.origin}/settings`, 403));
  assert.equal((await mabel.request(`${a.origin}/settings`)).status, 403);
  assert.equal((await mabel.api(`${a.origin}/api/me`)).data.team.role, 'member');
  // Removal from the team: the team disappears and the session falls back to the personal space.
  assert.deepEqual((await ownerBrowser.account(`${membership}/remove`, {})).data, { removed: true });
  const dropped = (app) => async () => {
    const { data } = await mabel.api(`${app.origin}/api/me`);
    return (data.teams.length === 1 && data.team.id === personal.id) || data.teams.map(({ name }) => name);
  };
  await within(notified, 'team removal by notification, default intervals', dropped(c));
  await within(notified, 'team removal by notification', dropped(a));
  await within(polled, 'team removal without notifications', dropped(b));
  assert.equal((await anyone.api(`${b.origin}/api/me`, bearer(spare.token))).status, 401, 'the Agent token of the removed team');
  step('a role change and a removal from the team reach every application, with and without notifications');

  // Identity unreachable: an established session keeps working for the grace period and no longer.
  const outage = await issue('Outage agent', personal.id);
  assert.equal((await anyone.api(`${b.origin}/api/me`, bearer(outage.token))).status, 200);
  assert.equal((await mabel.api(`${b.origin}/api/me`)).status, 200);
  await identity.close();
  identity = undefined;
  const down = Date.now();
  await sleep((check + 1) * 1_000);
  assert.equal((await mabel.api(`${b.origin}/api/me`)).status, 200, 'a session survives a failed check during the grace period');
  assert.equal((await anyone.api(`${b.origin}/api/me`, bearer(outage.token))).status, 200, 'an Agent token survives a failed check during the grace period');
  assert.equal((await new Browser().request(b.origin + b.deep)).status, 302, 'a visitor is still sent to sign in');
  await within((grace + 1) * 1_000, 'session refused after the grace period', status(mabel, `${b.origin}/api/me`, 503));
  assert.ok(Date.now() - down >= (grace - check - 1) * 1_000, 'the session was not refused early');
  const refusal = await mabel.api(`${b.origin}/api/me`);
  assert.deepEqual(refusal.data, { error: 'identity_unavailable', message: 'The sign-in service is temporarily unavailable' });
  assert.equal(UNAVAILABLE_MESSAGE.en, refusal.data.message);
  assert.equal((await mabel.api(`${b.origin}/api/me`, { 'accept-language': 'zh-CN' })).data.message, '登录服务暂时不可用');
  const refusedPage = await mabel.request(b.origin + b.deep);
  assert.equal(refusedPage.status, 503);
  assert.match(refusedPage.text, /The sign-in service is temporarily unavailable/);
  await within((grace + 1) * 1_000, 'Agent token refused after the grace period', status(anyone, `${b.origin}/api/me`, 503, bearer(outage.token)));
  assert.equal((await anyone.api(`${b.origin}/api/me`, bearer(`nvt_${'B'.repeat(43)}`))).status, 503, 'an unknown token cannot be judged during an outage');
  assert.equal((await mabel.api(`${c.origin}/api/me`)).status, 200, 'with the default 5 minutes the session is still inside its grace period');
  identity = await service(pool);
  await within(polled, 'session works again', status(mabel, `${b.origin}/api/me`, 200));
  await within(polled, 'Agent token works again', status(anyone, `${b.origin}/api/me`, 200, bearer(outage.token)));
  step(`Identity unreachable: sessions and Agent tokens survive the grace period (${grace} s here), then get 503 with the message; back online they work again`);

  // "All Niltavi apps in this browser", started from A, ends the sessions of the other applications too.
  let leaving = await mabel.request(`${a.origin}/auth/logout`, { form: { scope: 'browser' }, headers: { origin: a.origin } });
  assert.equal(leaving.status, 303);
  const endSession = new URL(leaving.location);
  assert.equal(endSession.origin + endSession.pathname, `${issuer}/session/end`);
  assert.equal(endSession.searchParams.get('post_logout_redirect_uri'), `${a.origin}/auth/signed-out`);
  assert.ok(endSession.searchParams.get('id_token_hint'));
  assert.equal((await mabel.api(`${a.origin}/api/me`)).status, 401);
  leaving = await mabel.request(leaving.location);
  assert.equal(leaving.status, 200);
  const confirm = /<form id="op\.logoutForm" method="post" action="([^"]+)"><input type="hidden" name="xsrf" value="([^"]+)"/.exec(leaving.text);
  assert.ok(confirm, 'Identity asks to confirm signing out of all applications in this browser');
  leaving = await mabel.request(confirm[1], { form: { xsrf: confirm[2], logout: 'yes' }, headers: { origin: issuer } });
  const landed = await mabel.go(leaving.location);
  assert.equal(new URL(landed.final.url).origin + new URL(landed.final.url).pathname, `${a.origin}/auth/signed-out`);
  assert.match(landed.final.text, /You have signed out of Flagstone Demo/);
  await within(notified, 'sign-out by notification, default intervals', status(mabel, `${c.origin}/api/me`, 401));
  await within(polled, 'sign-out without notifications', status(mabel, `${b.origin}/api/me`, 401));
  step('signing out of all applications in this browser from one application ends the sessions of the others');

  // "All devices" from the account center ends every application session.
  const signInEverywhere = async () => {
    for (const app of [a, b, c]) {
      const again = await mabel.go(app.origin + app.deep, credentials);
      assert.equal(again.final.url, app.origin + app.deep);
      assert.equal((await mabel.api(`${app.origin}/api/me`)).status, 200);
    }
  };
  await signInEverywhere();
  assert.equal((await mabel.account('/account/end-sessions', {})).status, 204);
  await within(notified, 'all devices by notification, default intervals', status(mabel, `${c.origin}/api/me`, 401));
  await within(notified, 'all devices by notification', status(mabel, `${a.origin}/api/me`, 401));
  await within(polled, 'all devices without notifications', status(mabel, `${b.origin}/api/me`, 401));
  step('signing out of all devices ends every application session');

  await signInEverywhere();
  assert.equal((await anyone.api(`${b.origin}/api/me`, bearer(outage.token))).status, 200);
  await setApplicationEnabled(pool, b.id, false);
  // Wait out the normal freshness interval while remaining inside the outage grace period.
  await sleep(check * 1_000 + 100);
  assert.equal((await mabel.api(`${b.origin}/api/me`)).status, 401);
  assert.equal((await anyone.api(`${b.origin}/api/me`, bearer(outage.token))).status, 401);
  assert.equal((await mabel.api(`${a.origin}/api/me`)).status, 200);
  await setApplicationEnabled(pool, b.id, true);
  step('a disabled application loses cached browser and Agent access at the next check');

  // A disabled account loses its application sessions within one check interval, with no notification at all.
  await signInEverywhere();
  await setAccountEnabled(pool, member.email, false);
  await within(polled, 'disabled account on A', status(mabel, `${a.origin}/api/me`, 401));
  await within(polled, 'disabled account on B', status(mabel, `${b.origin}/api/me`, 401));
  const refusedSignIn = await mabel.go(a.origin + a.deep, credentials);
  assert.notEqual(refusedSignIn.final.url, a.origin + a.deep);
  step('a disabled account loses its application sessions within one check interval');

  failed = false;
  console.log('SDK acceptance passed.');
} finally {
  for (const child of children) {
    child.removeAllListeners('exit');
    child.kill('SIGTERM');
    if (failed && child.output.trim()) console.error(child.output.trimEnd());
  }
  await fastify?.close();
  await trusting?.close();
  await identity?.close();
  await pool.end();
  await dbAdmin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await dbAdmin.end();
  await rm(files, { recursive: true, force: true });
}
