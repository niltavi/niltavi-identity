import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { firefox, expect } from '@playwright/test';

const origin = 'https://identity.testenv.niltavi.com';
const screenshots = process.env.IDENTITY_WORKSPACE_EVIDENCE;
const suffix = randomBytes(5).toString('hex');
const password = randomBytes(24).toString('base64url');
const browser = await firefox.launch({ headless: true });
let phase = 'opening public Discovery';

try {
  for (const [locale, prefix, domain] of [['en-US', '', 'example.com'], ['zh-CN', '/zh', 'company.example.org']]) {
    const context = await browser.newContext({ locale, ignoreHTTPSErrors: false });
    try {
      const page = await context.newPage();
      const chinese = prefix === '/zh';
      const label = (en, zh) => chinese ? zh : en;
      const address = 'identity-onboarding-' + suffix + '@' + domain;
      await page.goto(origin + prefix + '/register');
      const config = await page.evaluate(async () => (await fetch('/account/config')).json());
      assert.equal(config.registrationMode, 'unverified-testenv');
      assert.equal(config.registrationAvailable, true);
      assert.equal(config.managedAccounts, false);
      assert.equal(config.registrationDomain, undefined);
      await expect(page.getByRole('heading', { name: label('Register by email', '邮箱注册') })).toBeVisible();
      await expect(page.locator('form input')).toHaveCount(2);
      await expect(page.getByLabel(label('Email', '邮箱'), { exact: true })).toHaveValue('');
      await expect(page.locator('main')).not.toContainText(/n(?:ai|i)ltavi\.test/);
      phase = locale + ' signup';
      async function enter(email, secret) {
        await page.getByLabel(label('Email', '邮箱'), { exact: true }).fill(email);
        await page.getByLabel(label('Password', '密码'), { exact: true }).fill(secret);
      }
      await expect(page.getByRole('button', { name: label('Register by email', '邮箱注册'), exact: true })).toBeEnabled();
      await enter(address, password);
      phase = locale + ' signup response';
      const [created] = await Promise.all([
        page.waitForResponse(response => response.url() === origin + '/account/register'),
        page.getByRole('button', { name: label('Register by email', '邮箱注册'), exact: true }).click(),
      ]);
      assert.equal(created.status(), 201);
      assert.deepEqual(await created.json(), { created: true, emailVerified: false });
      phase = locale + ' signup redirect and confirmation';
      await page.waitForURL(origin + prefix + '/login');
      await expect(page.getByText(label('Your account is ready', '账号已创建'), { exact: false })).toBeVisible();
      phase = locale + ' sign-in and durable workspace';
      await enter(address, password);
      const [signed] = await Promise.all([
        page.waitForResponse(response => response.url() === origin + '/account/login'),
        page.getByRole('button', { name: label('Sign in by email', '邮箱登录'), exact: true }).click(),
      ]);
      assert.equal(signed.status(), 204);
      await page.waitForURL(origin + prefix + '/workspace');
      await expect(page.getByText(label('Unverified', '未验证'), { exact: true })).toBeVisible();
      await expect(page.getByText(label('Manage accounts', '账号管理'), { exact: true })).toHaveCount(0);
      const account = () => page.evaluate(async () => (await (await fetch('/account/session')).json()).account);
      const initial = await account();
      assert.equal(initial.emailVerified, false);
      await page.reload();
      assert.equal((await account()).id, initial.id);
      if (screenshots) {
        await mkdir(screenshots, { recursive: true });
        await page.screenshot({ path: join(screenshots, 'public-workspace-' + locale + '.png'), fullPage: true });
      }
      phase = locale + ' logout and duplicate denial';
      await page.getByRole('button', { name: label('Sign out', '退出'), exact: true }).click();
      await page.waitForURL(origin + prefix + '/login');
      assert.equal(await page.evaluate(async () => (await fetch('/account/session')).status), 401);
      await page.goto(origin + prefix + '/register');
      await enter(address, randomBytes(24).toString('base64url'));
      const [duplicate] = await Promise.all([
        page.waitForResponse(response => response.url() === origin + '/account/register'),
        page.getByRole('button', { name: label('Register by email', '邮箱注册'), exact: true }).click(),
      ]);
      assert.equal(duplicate.status(), 409);
      await expect(page.getByText(label('This email already has an account', '此邮箱已有账号'), { exact: false })).toBeVisible();
      await page.goto(origin + prefix + '/login');
      await enter(address, password);
      await page.getByRole('button', { name: label('Sign in by email', '邮箱登录'), exact: true }).click();
      await page.waitForURL(origin + prefix + '/workspace');
      assert.equal((await account()).id, initial.id);
      await page.getByRole('button', { name: label('Sign out', '退出'), exact: true }).click();
      await page.waitForURL(origin + prefix + '/login');
      console.log(locale + ': public TLS, ordinary signup, unverified status, persisted workspace, logout and duplicate protection passed.');
    } finally { await context.close(); }
  }

  phase = 'checking Discovery and same-origin enforcement';
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  try {
    const page = await context.newPage();
    const discovery = await (await page.goto(origin + '/.well-known/openid-configuration')).json();
    assert.equal(discovery.issuer, origin);
    assert.ok(discovery.scopes_supported.includes('email'));
    assert.ok(discovery.prompt_values_supported.includes('create'));
    assert.ok(discovery.code_challenge_methods_supported.includes('S256'));
    const denied = await context.request.post(origin + '/account/register', {
      headers: { origin: 'https://unrelated.example.org' },
      data: { email: 'cross-origin-fixture@example.org', password },
    });
    assert.equal(denied.status(), 403);
    console.log('Discovery advertises email, create and S256. Cross-origin registration returned 403.');
  } finally { await context.close(); }
} catch {
  console.error('Public onboarding check stopped during ' + phase + '.');
  process.exitCode = 1;
} finally { await browser.close(); }
