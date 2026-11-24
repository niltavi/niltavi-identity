import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { firefox, expect } from '@playwright/test';

const identity = 'https://identity.testenv.niltavi.com';
const flagstone = 'https://flagstone.testenv.niltavi.com';
const wattlework = 'https://wattlework.testenv.niltavi.com';
const address = 'identity-cross-rp-' + randomBytes(6).toString('hex') + '@company.example.org';
const password = randomBytes(24).toString('base64url');
const browser = await firefox.launch({ headless: true });
let phase = 'checking the public application entry points';

try {
  const context = await browser.newContext({ locale: 'en-US', ignoreHTTPSErrors: false });
  const a = await context.newPage();
  const b = await context.newPage();
  const flags = await (await a.goto(flagstone + '/api/public')).json();
  assert.equal(flags.sso, true);
  const start = await b.goto(wattlework + '/auth/oidc/start');
  assert.equal(new URL(b.url()).origin, identity, 'The Wattlework sign-in entry must reach the public issuer.');
  assert.equal(start.status(), 200);

  phase = 'registering from Flagstone and completing its original callback';
  await a.goto(flagstone + '/api/identity/start');
  await a.getByRole('link', { name: 'Register by email' }).click();
  await a.waitForURL(identity + '/register');
  await a.getByLabel('Email', { exact: true }).fill(address);
  await a.getByLabel('Password', { exact: true }).fill(password);
  const [signup] = await Promise.all([
    a.waitForResponse(response => response.url() === identity + '/account/register'),
    a.getByRole('button', { name: 'Register by email', exact: true }).click(),
  ]);
  assert.equal(signup.status(), 201);
  const enrollment = await signup.json();
  assert.equal(enrollment.emailVerified, false);
  await a.waitForURL(identity + enrollment.continueTo);
  const outside = await browser.newContext({ ignoreHTTPSErrors: false });
  try {
    assert.equal((await (await outside.newPage()).goto(identity + enrollment.continueTo)).status(), 400);
  } finally { await outside.close(); }
  await a.getByRole('button', { name: 'Continue', exact: true }).click();
  await a.waitForURL(url => url.origin === flagstone && url.pathname === '/app');
  const profile = await a.evaluate(async () => (await (await fetch('/api/profile')).json()));
  assert.equal(profile.email, address);
  assert.equal(profile.identitySession, true);
  console.log('Flagstone: the original browser finished its public callback. A clean browser received 400 for the same continuation.');

  phase = 'signing in to Wattlework without a second registration or password';
  const prompted = [];
  b.on('framenavigated', frame => {
    if (frame === b.mainFrame() && frame.url().startsWith(identity + '/interaction/')) prompted.push(true);
  });
  await b.goto(wattlework + '/auth/oidc/start');
  await b.waitForURL(url => url.origin === wattlework && !url.pathname.startsWith('/auth/'));
  assert.equal(prompted.length, 0);
  const member = await b.evaluate(async () => (await (await fetch('/api/session')).json()));
  assert.equal(member.email, address);
  assert.equal(member.role, 'member');
  console.log('Wattlework: the same browser reused the Identity session and received only an ordinary workspace member role.');

  phase = 'confirming both grants belong to one subject';
  const hostIp = process.env.IDENTITY_WLAN_IPV4;
  if (!hostIp) throw new Error('Set the already authorized Windows SSH source interface.');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const sql = "SELECT count(DISTINCT payload->>'clientId') FROM oidc_records JOIN accounts ON accounts.id=account_id " +
    "WHERE accounts.email=" + quote(address) + " AND payload->>'clientId' IN ('flagstone','wattlework');";
  const command = 'docker exec niltavi-identity-db-1 psql -U identity -d identity -X -qAt -c ' + quote(sql);
  const grants = execFileSync('ssh', ['-b', hostIp, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=10', '1panel', command], { windowsHide: true, timeout: 20000, encoding: 'utf8' }).trim();
  assert.equal(grants, '2');
  console.log('Read-only Identity database check: one subject had records for both exact clients.');

  phase = 'isolating a fresh browser and signing out of both applications';
  const clean = await browser.newContext({ ignoreHTTPSErrors: false });
  try {
    const anonymous = await clean.newPage();
    assert.equal((await anonymous.goto(flagstone + '/api/profile')).status(), 401);
    assert.equal((await anonymous.goto(wattlework + '/api/session')).status(), 401);
  } finally { await clean.close(); }

  const logout = await b.evaluate(async () => {
    const response = await fetch('/api/session/identity-logout', { method: 'POST' });
    return response.ok ? (await response.json()).url : undefined;
  });
  assert.ok(logout && new URL(logout).origin === identity);
  await b.goto(logout);
  await b.getByRole('button', { name: /End session/ }).click();
  await b.waitForURL(url => url.origin === wattlework && url.pathname === '/login');
  await expect.poll(() => a.evaluate(async () => (await fetch('/api/profile')).status)).toBe(401);
  assert.equal(await b.evaluate(async () => (await fetch('/api/session')).status), 401);
  console.log('Central logout: both application sessions became unauthorized. A clean browser had no access to either.');
  await context.close();

  phase = 'checking the explicit create prompt with the Wattlework callback';
  const newContext = await browser.newContext({ locale: 'en-US', ignoreHTTPSErrors: false });
  try {
    const page = await newContext.newPage();
    const rpStart = await newContext.request.get(wattlework + '/auth/oidc/register', { maxRedirects: 0 });
    assert.equal(rpStart.status(), 302);
    const authorization = new URL(rpStart.headers().location);
    assert.equal(authorization.origin, identity);
    // Explicitly request the optional create prompt while retaining the RP's state, nonce and PKCE.
    authorization.searchParams.set('prompt', 'create');
    await page.goto(authorization.href);
    await page.waitForURL(identity + '/register');
    const newAddress = 'identity-create-' + randomBytes(6).toString('hex') + '@example.org';
    await page.getByLabel('Email', { exact: true }).fill(newAddress);
    await page.getByLabel('Password', { exact: true }).fill(randomBytes(24).toString('base64url'));
    const [registration] = await Promise.all([
      page.waitForResponse(response => response.url() === identity + '/account/register'),
      page.getByRole('button', { name: 'Register by email', exact: true }).click(),
    ]);
    assert.equal(registration.status(), 201);
    const created = await registration.json();
    assert.equal(created.emailVerified, false);
    await page.waitForURL(identity + created.continueTo);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.waitForURL(url => url.origin === wattlework && !url.pathname.startsWith('/auth/'));
    const session = await page.evaluate(async () => (await (await fetch('/api/session')).json()));
    assert.equal(session.email, newAddress);
    assert.equal(session.role, 'member');
    console.log('Identity prompt=create registered a fresh account and completed the original public Wattlework callback as an ordinary member (test explicitly supplied the prompt).');
  } finally { await newContext.close(); }
} catch {
  console.error('Public two-app acceptance stopped during ' + phase + '.');
  process.exitCode = 1;
} finally { await browser.close(); }
