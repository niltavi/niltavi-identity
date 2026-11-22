import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { firefox, expect } from '@playwright/test';

const origin = new URL(process.argv[2] ?? 'https://40.160.59.116:36100').origin;
const evidence = process.env.IDENTITY_WORKSPACE_EVIDENCE;
const browser = await firefox.launch({ headless: true });
const page = await browser.newPage({ locale: 'en-US', colorScheme: 'light', ignoreHTTPSErrors: false });
const routes = { login: '/login', register: '/register' };

try {
  const response = await page.goto(origin);
  assert.equal(response?.status(), 200);
  assert.equal(page.url(), `${origin}/`);
  await expect(page).toHaveTitle('Niltavi Identity');
  await expect(page.getByRole('heading', { name: 'One account for your apps' })).toBeVisible();
  await expect(page.locator('form')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  assert.equal((await page.request.get(`${origin}/account/session`)).status(), 401);

  const header = page.getByRole('banner');
  await expect(header.getByRole('link', { name: 'Identity', exact: true })).toBeVisible();
  await expect(header).not.toContainText('Niltavi');
  const focusOrder = [header.getByRole('link', { name: 'Identity', exact: true }), header.getByRole('button', { name: 'Switch to dark theme' }),
    header.getByRole('button', { name: '切换到简体中文' }), header.getByRole('link', { name: 'GitHub repository' })];
  for (const control of focusOrder) {
    await page.keyboard.press('Tab');
    await expect(control).toBeFocused();
    assert.equal(await control.evaluate((element) => element.matches(':focus-visible')), true);
  }
  await expect(focusOrder[3]).toHaveAttribute('href', 'https://github.com/niltavi/niltavi-identity');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: /一个账号，\s*登录多个应用/ })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await header.getByRole('button', { name: '切换到深色主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByRole('contentinfo').getByRole('link')).toHaveCount(1);
  await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Niltavi' })).toHaveAttribute('href', 'https://niltavi.com/');
  await expect(page.locator('footer img').nth(1)).toBeVisible();

  const sizes = [[320, 320], [575, 575], [576, 540], [767, 540], [768, 720], [991, 720], [992, 960],
    [1199, 960], [1200, 1140], [1399, 1140], [1400, 1320]];
  async function checkWidths() {
    for (const [width, expected] of sizes) {
      await page.setViewportSize({ width, height: 850 });
      const widths = await page.locator('header > div, main, footer').evaluateAll(elements =>
        elements.map(element => element.getBoundingClientRect().width));
      assert.deepEqual(widths, [expected, expected, expected], `Responsive containers at ${width}px`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
  }
  await checkWidths();
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await page.setViewportSize({ width: 320, height: 850 });
    await page.screenshot({ path: join(evidence, 'website-mobile-dark-zh.png'), fullPage: true });
  }
  await header.getByRole('button', { name: 'Switch to English' }).click();
  await header.getByRole('button', { name: 'Switch to light theme' }).click();
  await expect(page.locator('footer img').first()).toBeVisible();
  await checkWidths();
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.mouse.move(5, 150);
  if (evidence) await page.screenshot({ path: join(evidence, 'website-desktop-light-en.png'), fullPage: true });
  const asset = await page.locator('script[type=module]').getAttribute('src');

  await page.getByRole('link', { name: 'Install with an agent' }).click();
  await expect(page.locator('body')).toContainText('# Install Niltavi Identity');
  await expect(page.locator('body')).toContainText('docker compose');
  console.log(`English agent guide ${new URL(page.url()).pathname}`);
  for (const [label, path, heading] of [['Email sign-in', routes.login, '邮箱登录'], ['Register by email', routes.register, '邮箱注册']]) {
    await page.goto(origin);
    await page.getByRole('link', { name: label }).click();
    await page.waitForURL(`${origin}${path}`);
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Identity', exact: true }).click();
    await page.waitForURL(`${origin}/`);
  }
  console.log(`Website ${origin}/ passed strict TLS, clean entry, keyboard, themes, languages, 11 widths, footer, guide, and account links.`);
  console.log(`Served JavaScript ${asset}`);
} finally {
  await browser.close();
}
