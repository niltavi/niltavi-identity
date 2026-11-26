import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firefox, expect } from '@playwright/test';

const origin = new URL(process.argv[2] ?? 'https://identity.testenv.niltavi.com').origin;
const evidence = process.env.IDENTITY_WORKSPACE_EVIDENCE;
const seed = process.env.IDENTITY_LOCAL_NSS_SEED;
const profile = await mkdtemp(join(tmpdir(), 'identity-website-profile-'));
if (seed) for (const file of ['cert9.db', 'key4.db']) await copyFile(join(seed, file), join(profile, file));
const context = await firefox.launchPersistentContext(profile, {
  headless: true, locale: 'en-US', colorScheme: 'light', ignoreHTTPSErrors: false,
  firefoxUserPrefs: { 'security.enterprise_roots.enabled': false, 'security.certerrors.mitm.auto_enable_enterprise_roots': false,
    ...(seed ? { 'network.proxy.type': 0, 'network.dns.localDomains': new URL(origin).hostname } : {}) },
});
const page = context.pages()[0] ?? await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const localized = [
  ['/', 'en', 'One identity, wherever you go', 'Niltavi Identity', '/', '/zh/'],
  ['/zh/', 'zh-CN', '一个身份随处可用', 'Niltavi Identity · 统一登录', '/', '/zh/'],
  ['/self-host', 'en', 'Self-host', 'Self-host · Niltavi Identity', '/self-host', '/zh/self-host'],
  ['/zh/self-host', 'zh-CN', '本地部署', '本地部署 · Niltavi Identity', '/self-host', '/zh/self-host'],
];

try {
  for (const [path, lang, heading, title, en, zh] of localized) {
    const initial = await page.goto(origin + path);
    assert.equal(initial.status(), 200);
    const markup = (await initial.body()).toString('utf8');
    assert.match(markup, /<h1[^>]*>[^]*?<\/h1>/);
    assert.match(markup.replace(/<[^>]+>/g, ''), new RegExp(heading));
    assert.ok(markup.includes('<html lang="' + lang + '">'));
    assert.ok(markup.includes('<title>' + title + '</title>'));
    assert.ok(markup.includes('<meta name="description"'));
    assert.ok(markup.includes('href="' + origin + path + '"'));
    assert.equal(page.url(), origin + path);
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await expect(page).toHaveTitle(title);
    await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', origin + path);
    await expect(page.locator('link[hreflang="en"]')).toHaveAttribute('href', origin + en);
    await expect(page.locator('link[hreflang="zh-CN"]')).toHaveAttribute('href', origin + zh);
    await expect(page.locator('link[hreflang=x-default]')).toHaveAttribute('href', origin + en);
    await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', 'index,follow');
    if (path === '/' || path === '/zh/') {
      await page.locator('main img[src$="identity-logo-textured.png"]').evaluate(image => image.decode());
    }
    assert.equal(await page.locator('form').count(), 0);
  }
  const sitemap = await page.evaluate(async () => (await fetch('/sitemap.xml')).text());
  for (const [path] of localized) assert.ok(sitemap.includes('<loc>' + origin + path + '</loc>'));
  assert.equal(await page.evaluate(async () => (await fetch('/account/session')).status), 401);

  await page.goto(origin + '/');
  const header = page.getByRole('banner');
  const brand = header.getByRole('link', { name: 'Identity', exact: true });
  const nav = header.getByRole('navigation');
  const homeTab = nav.getByRole('link', { name: 'Home', exact: true });
  const deployTab = nav.getByRole('link', { name: 'Self-host', exact: true });
  const signIn = header.getByRole('link', { name: 'Sign in', exact: true });
  const theme = header.getByRole('button', { name: 'Switch to dark theme' });
  const language = header.getByRole('button', { name: 'Language' });
  const github = header.getByRole('link', { name: 'GitHub repository' });
  await expect(github).toHaveAttribute('href', 'https://github.com/niltavi/niltavi-identity');
  const brandMetrics = await brand.evaluate(n => {
    const rules = getComputedStyle(n);
    const symbol = n.querySelector('.niltavi-project-brand__symbol > *').getBoundingClientRect();
    return [rules.fontSize, rules.fontWeight, rules.lineHeight, rules.gap, symbol.width, symbol.height];
  });
  assert.deepEqual(brandMetrics, ['20px', '500', '20px', '10px', 40, 40]);
  assert.deepEqual(await theme.evaluate(n => [n.getBoundingClientRect().width, n.querySelector('svg').getBoundingClientRect().width]), [32, 18]);

  await expect(nav.getByRole('link')).toHaveCount(2);
  await expect(homeTab).toHaveAttribute('aria-current', 'page');
  for (const control of [brand, homeTab, deployTab, signIn, theme, language]) {
    await page.keyboard.press('Tab');
    await expect(control).toBeFocused();
    assert.equal(await control.evaluate(n => n.matches(':focus-visible')), true);
  }
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'Language' });
  await expect(menu).toBeVisible();
  await expect(menu.getByText('English', { exact: true })).toHaveAttribute('aria-current', 'true');
  await page.evaluate(() => { window.__identityDoc = 'retained'; });
  const chinese = menu.getByText('简体中文', { exact: true }).locator('xpath=ancestor::*[@href][1]');
  await expect(chinese).toHaveAttribute('href', '/zh/');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.waitForURL(origin + '/zh/');
  assert.equal(await page.evaluate(() => window.__identityDoc), 'retained');
  await expect(page.getByRole('heading', { name: '一个身份随处可用' })).toBeVisible();
  await header.getByRole('button', { name: '切换到深色主题' }).click();

  async function brandColorCheck() {
    const [name, symbol] = await brand.evaluate(n => [
      getComputedStyle(n.querySelector('.niltavi-project-brand__name')).color,
      getComputedStyle(n.querySelector('.niltavi-project-brand__symbol > *')).backgroundColor,
    ]);
    assert.equal(symbol, name);
  }

  async function colorCheck(mode) {
    const [canvas, root, expected] = await page.evaluate(mode => {
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(' + (mode === 'dark' ? '--color-throat-975' : '--color-paper') + ')';
      document.body.append(probe);
      const colors = [document.body, document.querySelector('#root > div'), probe]
        .map(n => getComputedStyle(n).backgroundColor);
      probe.remove();
      return colors;
    }, mode);
    assert.equal(root, expected);
    assert.equal(canvas, expected);
    return expected;
  }

  const sizes = [[320,320],[575,575],[576,540],[767,540],[768,720],[991,720],[992,960],
    [1199,960],[1200,1140],[1399,1140],[1400,1320]];
  async function widths() {
    for (const [width, expected] of sizes) {
      await page.setViewportSize({ width, height: 850 });
      const widths = await page.locator('header > div, main, footer').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().width));
      assert.deepEqual(widths, [expected, expected, expected], 'Container width at ' + width);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth),
        { message: 'Page width at ' + width + 'px' }).toBeLessThanOrEqual(width);
      const nameOverflow = await brand.locator('.niltavi-project-brand__name').evaluate(n => n.scrollWidth - n.clientWidth);
      assert.ok(nameOverflow <= 1, 'Brand name overflow at ' + width + 'px: ' + nameOverflow + 'px');
    }
  }
  const dark = await colorCheck('dark');
  await brandColorCheck();
  await widths();
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await page.setViewportSize({ width: 320, height: 850 });
    await page.mouse.move(3, 140);
    await page.screenshot({ path: join(evidence, 'identity-zh-dark-320.png'), fullPage: true });
  }

  const mobile = page.getByRole('main');
  const registerLink = mobile.getByRole('link', { name: '创建账号' });
  await expect(registerLink).toHaveClass(/button--primary/);
  await registerLink.click();
  await page.waitForURL(origin + '/zh/register');
  await expect(mobile).toHaveClass('nt-authlayout__content');
  await expect(mobile.getByRole('heading', { name: '创建账号' })).toBeVisible();
  await expect(mobile.getByLabel('邮箱', { exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => window.__identityDoc), 'retained');
  await page.goBack();
  await page.waitForURL(origin + '/zh/');
  await mobile.getByRole('link', { name: '本地部署' }).click();
  await page.waitForURL(origin + '/zh/self-host');
  await expect(nav.getByRole('link', { name: '本地部署' })).toHaveAttribute('aria-current', 'page');
  assert.equal(await page.evaluate(() => window.__identityDoc), 'retained');
  assert.equal(await colorCheck('dark'), dark);
  await widths();
  await page.setViewportSize({ width: 320, height: 850 });
  await expect(page.getByRole('button', { name: '复制提示词' })).toBeInViewport();
  if (evidence) await page.screenshot({ path: join(evidence, 'identity-self-host-zh-dark-320.png'), fullPage: true });
  await header.getByRole('button', { name: '语言' }).click();
  await page.getByRole('menu').getByText('English', { exact: true }).click();
  await page.waitForURL(origin + '/self-host');
  await expect(deployTab).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await page.waitForURL(origin + '/zh/self-host');
  await expect(page.getByRole('heading', { name: '本地部署' })).toBeVisible();
  await nav.getByRole('link', { name: '首页' }).click();
  await page.waitForURL(origin + '/zh/');

  let releaseConfig;
  const configGate = new Promise(resolve => { releaseConfig = resolve; });
  let reportHeld;
  const configHeld = new Promise(resolve => { reportHeld = resolve; });
  await page.route('**/account/session', async intercepted => {
    reportHeld();
    await configGate;
    await intercepted.continue();
  });
  await header.getByRole('link', { name: '登录' }).click();
  try {
    await Promise.race([configHeld, new Promise((_, reject) => setTimeout(() => reject(new Error('Session request was not held')), 8000).unref())]);
    await page.waitForURL(origin + '/zh/login');
    await expect(page.getByRole('main').locator('[aria-busy="true"]')).toBeVisible();
    await expect(header.getByRole('button', { name: '语言' })).toBeVisible();
    assert.equal(await page.evaluate(() => window.__identityDoc), 'retained');
    assert.equal(await colorCheck('dark'), dark);
  } finally { releaseConfig(); }
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeEnabled();
  await page.unroute('**/account/session');
  await header.getByRole('button', { name: '语言' }).click();
  await page.getByRole('menu').getByText('English', { exact: true }).click();
  await page.waitForURL(origin + '/login');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => window.__identityDoc), 'retained');
  assert.equal(await colorCheck('dark'), dark);
  await page.goBack();
  await page.waitForURL(origin + '/zh/login');
  await page.goBack();
  await page.waitForURL(origin + '/zh/');
  await header.getByRole('button', { name: '语言' }).click();
  await page.getByRole('menu').getByText('English', { exact: true }).click();
  await page.waitForURL(origin + '/');
  await header.getByRole('button', { name: 'Switch to light theme' }).click();
  const light = await colorCheck('light');
  assert.notEqual(light, dark);
  await brandColorCheck();
  await widths();
  await page.setViewportSize({ width: 1280, height: 850 });
  await expect(page.getByRole('contentinfo').getByRole('link')).toHaveCount(1);
  await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Niltavi' })).toHaveAttribute('href', 'https://niltavi.com/');
  if (evidence) {
    await page.mouse.move(3, 140);
    await page.screenshot({ path: join(evidence, 'identity-en-light-desktop.png'), fullPage: true });
  }
  await deployTab.click();
  await page.waitForURL(origin + '/self-host');
  await expect(deployTab).toHaveAttribute('aria-current', 'page');
  assert.equal(await page.evaluate(() => window.__identityDoc), 'retained');
  const preview = page.getByRole('button', { name: 'Prompt preview' });
  const prompt = page.getByText('Help me deploy Niltavi Identity on my machine.', { exact: false });
  await expect(preview).toHaveAttribute('aria-expanded', 'false');
  await expect(prompt).toBeHidden();
  const copyPrompt = page.getByRole('button', { name: 'Copy prompt' });
  await page.evaluate(() => {
    navigator.clipboard.writeText = async text => { window.__identityCopiedPrompt = text; };
  });
  await copyPrompt.click();
  await expect(page.getByRole('status')).toHaveText('Copied. Paste the prompt into your agent.');
  await expect(preview).toHaveAttribute('aria-expanded', 'false');
  if (evidence) {
    await page.mouse.move(3, 140);
    await page.screenshot({ path: join(evidence, 'identity-self-host-en-light-desktop.png'), fullPage: true });
  }
  await preview.press('Enter');
  await expect(preview).toHaveAttribute('aria-expanded', 'true');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('Docker Compose');
  await expect(prompt).toContainText('https://github.com/niltavi/niltavi-identity/blob/main/docs/en/for-agents.md');
  const mirror = '/identity-assets/for-agents.md';
  await expect(prompt).toContainText(origin + mirror);
  assert.match(await page.evaluate(async path => (await fetch(path)).text(), mirror), /Deploy with Docker Compose/);
  assert.equal(await page.evaluate(() => window.__identityCopiedPrompt), await prompt.textContent());
  await preview.press('Enter');
  await expect(prompt).toBeHidden();
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => { throw new DOMException('Clipboard denied', 'NotAllowedError'); };
  });
  await copyPrompt.click();
  await expect(page.getByRole('status')).toHaveText('Select and copy the prompt manually.');
  await expect(preview).toHaveAttribute('aria-expanded', 'true');
  await expect(prompt).toBeVisible();
  assert.equal(page.url(), origin + '/self-host');
  await homeTab.click();
  await page.waitForURL(origin + '/');
  await page.getByRole('link', { name: 'Create an account' }).click();
  await page.waitForURL(origin + '/register');
  await expect(page.getByRole('main')).toHaveClass('nt-authlayout__content');
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  assert.deepEqual(await page.locator('form input').evaluateAll(nodes => nodes.map(n => n.name)), ['email', 'password']);
  await expect(page.locator('form')).toHaveAttribute('method', 'post');
  const slow = await context.newPage();
  let releaseScript;
  const scriptGate = new Promise(resolve => { releaseScript = resolve; });
  await slow.route('**/identity-assets/index-*.js', async intercepted => {
    await scriptGate;
    await intercepted.continue();
  });
  try {
    const response = await slow.goto(origin + '/register', { waitUntil: 'commit' });
    assert.doesNotMatch((await response.body()).toString('utf8'), /<form\b|name="password"/);
    await expect(slow.getByRole('main').getByRole('status')).toHaveText('Loading…');
    await expect(slow.locator('input, form')).toHaveCount(0);
  } finally { releaseScript(); }
  await expect(slow.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(slow.locator('form')).toHaveAttribute('method', 'post');
  assert.equal(new URL(slow.url()).search, '');
  await slow.close();
  const isolated = await mkdtemp(join(profile, 'no-script-'));
  if (seed) for (const file of ['cert9.db', 'key4.db']) await copyFile(join(seed, file), join(isolated, file));
  const noScript = await firefox.launchPersistentContext(isolated, {
    headless: true, javaScriptEnabled: false, ignoreHTTPSErrors: false,
    firefoxUserPrefs: { 'security.enterprise_roots.enabled': false,
      ...(seed ? { 'network.proxy.type': 0, 'network.dns.localDomains': new URL(origin).hostname } : {}) },
  });
  try {
    const firstVisit = noScript.pages()[0];
    for (const path of ['/login', '/register']) {
      await firstVisit.goto(origin + path);
      await expect(firstVisit.locator('input, form')).toHaveCount(0);
      assert.equal(new URL(firstVisit.url()).search, '');
    }
  } finally { await noScript.close(); }
  assert.deepEqual(errors, []);
  console.log('Localized HTML, canonical and alternate URLs, sitemap, keyboard language selection, and no document reload passed.');
  console.log('Desktop and 320px, Niltava background tokens, navigation tabs, prompt copy and fallback, registration and delayed auth navigation passed.');
  console.log(JSON.stringify({ origin, dark, light }));
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
