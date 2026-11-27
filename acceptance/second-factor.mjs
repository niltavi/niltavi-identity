// Two-step sign-in against a fresh local stack (the instance must not be set up yet):
//   IDENTITY_LOCAL_PORT=37700 IDENTITY_LOCAL_STATE=$PWD/.identity/2fa node scripts/local.mjs   (in another terminal)
//   IDENTITY_LOCAL_PORT=37700 node acceptance/second-factor.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chromium } from '@playwright/test';
import pg from 'pg';
import { totpCode } from '../dist/credentials.js';

const base = Number(process.env.IDENTITY_LOCAL_PORT ?? 37700);
const origin = `https://identity.localhost:${base}`;
const mailApi = `http://localhost:${base + 4}/api/v1`;
const run = randomBytes(3).toString('hex');
const owner = { email: `owner-${run}@example.test`, password: `walk-${randomBytes(9).toString('base64url')}-Aa1` };
const browser = await chromium.launch({ headless: true });
const shots = process.env.SHOTS;
let failed = 0;
async function page() {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(10_000);
  return context.newPage();
}
async function step(name, work) {
  const t = Date.now();
  try { await work(); console.log(`ok    ${name} (${Date.now() - t} ms)`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n      ${String(e?.message ?? e).split('\n').slice(0, 5).join('\n      ')}`); }
}
async function mail(to, since) {
  for (let i = 0; i < 60; i++) {
    const list = await (await fetch(`${mailApi}/messages?limit=50`)).json();
    for (const s of list.messages ?? []) {
      if (new Date(s.Created).getTime() < since - 2000 || !s.To.some(({ Address }) => Address === to)) continue;
      const m = await (await fetch(`${mailApi}/message/${s.ID}`)).json();
      const f = /\b(\d{6})\b/.exec(m.Text ?? '');
      if (f) return f[1];
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('no mail');
}
let lastStep = 0, secret;
async function totp() {
  let s = Math.floor(Date.now() / 30000);
  if (s <= lastStep) s = lastStep + 1;
  const ahead = s * 30000 - Date.now();
  if (ahead > 29000) await new Promise(r => setTimeout(r, ahead - 29000));
  lastStep = s;
  return totpCode(secret, s * 30000);
}
async function password(p, path = '/login') {
  await p.goto(origin + path);
  await p.getByRole('link', { name: 'Use password' }).click({ timeout: 5000 }).catch(() => undefined);
  await p.getByLabel('Email').fill(owner.email);
  await p.getByRole('textbox', { name: /^Password/ }).fill(owner.password);
  await p.getByRole('button', { name: 'Sign in' }).click();
}
const center = p => p.getByRole('heading', { level: 1, name: 'Account center' }).waitFor();
let codes;

const o = await page();
await step('setup owner and mail', async () => {
  const html = await (await fetch(`http://localhost:${base + 9}/`)).text();
  await o.goto(/https:\/\/identity\.localhost:\d+\/setup#[\w-]{43}/.exec(html)[0]);
  await o.getByLabel('Email').fill(owner.email);
  await o.getByRole('textbox', { name: /^Password/ }).fill(owner.password);
  await o.getByRole('button', { name: 'Create owner account' }).click();
  await o.getByLabel('SMTP server').fill('127.0.0.1');
  await o.getByLabel('Port').fill(String(base + 5));
  await o.getByRole('button', { name: /Encryption/ }).click();
  await o.getByRole('option', { name: /None/ }).click();
  await o.getByLabel('Sender address').fill('identity@example.test');
  const sent = Date.now();
  await o.getByRole('button', { name: 'Send test message' }).click();
  await o.getByLabel('Code from the test message').fill(await mail(owner.email, sent));
  await o.getByRole('button', { name: 'Confirm and save' }).click();
  await o.getByRole('button', { name: 'Finish setup' }).click();
  await o.getByRole('heading', { name: 'Identity is ready' }).waitFor();
});

await step('enabling 2FA shows 10 recovery codes once', async () => {
  await o.goto(origin + '/workspace/security');
  await o.getByRole('button', { name: 'Set up two-step verification' }).click();
  secret = await o.locator('[data-secret="totp-secret"]').innerText();
  await o.getByLabel('6-digit code from the app').fill(await totp());
  await o.getByRole('button', { name: 'Turn on' }).click();
  const box = o.locator('[data-recovery-codes]');
  await box.waitFor();
  codes = await box.locator('li').allInnerTexts();
  assert.equal(codes.length, 10);
  codes.forEach(c => assert.match(c, /^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/));
  if (shots) await o.screenshot({ path: `${shots}/recovery-codes.png`, fullPage: true });
  await o.getByRole('button', { name: 'I have saved them' }).click();
  await o.getByText('10 recovery codes left.').waitFor();
});

await step('password alone no longer signs in; wrong code refused; authenticator code signs in', async () => {
  const p = await page();
  await password(p);
  await p.getByText('Enter the 6-digit code from your authenticator app.').waitFor();
  const r = await p.context().request.get(origin + '/account/session');
  assert.equal(r.status(), 401, 'session must not exist after password only');
  if (shots) await p.screenshot({ path: `${shots}/signin-factor.png`, fullPage: true });
  await p.locator('.nt-auth__otp input').pressSequentially('000000');
  await p.getByText('The code is incorrect or has expired').waitFor();
  await p.locator('.nt-auth__otp input').fill('');
  await p.locator('.nt-auth__otp input').pressSequentially(await totp());
  await center(p);
  await p.context().close();
});

await step('recovery code signs in once; count drops to 9; reuse refused', async () => {
  const p = await page();
  await password(p);
  await p.getByRole('link', { name: 'Use a recovery code' }).click();
  await p.getByLabel('Recovery code').fill(codes[0].toUpperCase());
  await p.getByRole('button', { name: 'Sign in' }).click();
  await center(p);
  await p.goto(origin + '/workspace/security');
  await p.getByText('9 recovery codes left.').waitFor();
  await p.context().close();
  const q = await page();
  await password(q);
  await q.getByRole('link', { name: 'Use a recovery code' }).click();
  await q.getByLabel('Recovery code').fill(codes[0]);
  await q.getByRole('button', { name: 'Sign in' }).click();
  await q.getByText('The code is incorrect or has expired').waitFor();
  await q.context().close();
});

await step('email code sign-in skips the second step', async () => {
  const p = await page();
  await p.goto(origin + '/login');
  await p.getByLabel('Email').fill(owner.email);
  const sent = Date.now();
  await p.getByRole('button', { name: 'Send code' }).click();
  await p.locator('.nt-auth__otp input').pressSequentially(await mail(owner.email, sent));
  await center(p);
  await p.context().close();
});

await step('application sign-in (OIDC) asks for the second step and returns to the app', async () => {
  const p = await page();
  await p.goto(`https://flagstone.localhost:${base + 1}/tasks/42`);
  await p.waitForURL(u => u.host === `identity.localhost:${base}`);
  await p.getByRole('link', { name: 'Use password' }).click({ timeout: 5000 }).catch(() => undefined);
  await p.getByLabel('Email').fill(owner.email);
  await p.getByRole('textbox', { name: /^Password/ }).fill(owner.password);
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.locator('.nt-auth__otp input').pressSequentially(await totp());
  await p.getByRole('button', { name: /Allow|Continue|Approve|同意|允许/ }).click({ timeout: 5000 }).catch(() => undefined);
  await p.waitForURL(u => u.host === `flagstone.localhost:${base + 1}`, { timeout: 15000 });
  await p.context().close();
});

await step('used-up recovery codes show the reset prompt; turning 2FA off clears them', async () => {
  const db = new pg.Client({ connectionString: `postgresql://identity:identity-local@127.0.0.1:${base + 6}/identity` });
  await db.connect();
  await db.query(`UPDATE recovery_codes SET used_at = now() WHERE account_id = (SELECT id FROM accounts WHERE email = $1)`, [owner.email]);
  await o.goto(origin + '/workspace/security');
  await o.getByText('No recovery codes are left.').waitFor();
  if (shots) await o.screenshot({ path: `${shots}/recovery-empty.png`, fullPage: true });
  await o.getByRole('button', { name: 'Manage two-step verification' }).click();
  const sent = Date.now();
  await o.getByRole('button', { name: 'Send verification code' }).click();
  await o.getByLabel('Verification code').pressSequentially(await mail(owner.email, sent));
  await o.getByRole('button', { name: 'Turn off two-step verification' }).click();
  await o.getByRole('button', { name: 'Set up two-step verification' }).waitFor();
  const left = await db.query(`SELECT count(*)::int AS n FROM recovery_codes WHERE account_id = (SELECT id FROM accounts WHERE email = $1)`, [owner.email]);
  assert.equal(left.rows[0].n, 0);
  await db.end();
  const p = await page();
  await password(p);
  await center(p);
});

await browser.close();
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
