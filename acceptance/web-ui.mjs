// Walks the browser UI end to end in a headless browser against a fresh local stack:
//   IDENTITY_LOCAL_PORT=36400 IDENTITY_LOCAL_STATE=$PWD/.identity/web node scripts/local.mjs   (in another terminal)
//   IDENTITY_LOCAL_PORT=36400 IDENTITY_LOCAL_STATE=$PWD/.identity/web node acceptance/web-ui.mjs
// The instance must not be initialized yet: the first journey is the setup wizard.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { totpCode } from '../dist/credentials.js';

const base = Number(process.env.IDENTITY_LOCAL_PORT ?? 36400);
const state = resolve(process.env.IDENTITY_LOCAL_STATE ?? '.identity/web');
const origin = `https://identity.localhost:${base}`;
const mailApi = `http://localhost:${base + 4}/api/v1`;
const launcher = `http://localhost:${base + 9}/`;
const smtpPort = String(base + 5);
const shots = join(state, 'shots');
await mkdir(shots, { recursive: true });

const run = randomBytes(3).toString('hex');
const password = () => `walk-${randomBytes(9).toString('base64url')}-Aa1`;
const people = Object.fromEntries(['owner', 'ada', 'ben', 'cy', 'dee'].map((name) =>
  [name, { email: `${name}-${run}@example.test`, password: password() }]));
people.cy.password = `glowfx${run}`;
people.dee.password = randomBytes(48).toString('base64url');
const results = [];
const browser = await chromium.launch({ headless: true });
const contexts = [];
const pageErrors = [];

async function session(options = {}) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, ...options });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin }).catch(() => undefined);
  contexts.push(context);
  context.setDefaultTimeout(10_000);
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(`${page.url().split('#')[0]}: ${error.message}`));
  return page;
}

async function journey(name, work) {
  const started = Date.now();
  try {
    await work();
    results.push({ name, ok: true });
    console.log(`ok    ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${String(error?.message ?? error).split('\n').slice(0, 6).join('\n      ')}`);
    for (const [index, context] of contexts.entries()) {
      for (const page of context.pages()) await page.screenshot({ path: join(shots, `fail-${name.replace(/\W+/g, '-').slice(0, 40)}-${index}.png`), fullPage: true }).catch(() => undefined);
    }
    // Later journeys build on earlier ones, so the first failure ends the run.
    await browser.close();
    process.exit(1);
  }
}

// The newest message to an address that arrived after `since`, read from the mail catcher.
async function mail(to, pattern, since) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const list = await (await fetch(`${mailApi}/messages?limit=50`)).json();
    for (const summary of list.messages ?? []) {
      if (new Date(summary.Created).getTime() < since - 2_000 || !summary.To.some(({ Address }) => Address === to)) continue;
      const message = await (await fetch(`${mailApi}/message/${summary.ID}`)).json();
      const found = pattern.exec(message.Text ?? '');
      if (found) return found[1] ?? found[0];
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`No message matching ${pattern} reached ${to}.`);
}
const codeIn = (to, since) => mail(to, /\b(\d{6})\b/, since);

// Each authenticator code works once, so later uses move on to a step the server has not seen.
let lastStep = 0;
let totpSecret;
async function authenticatorCode() {
  let step = Math.floor(Date.now() / 30_000);
  if (step <= lastStep) step = lastStep + 1;
  const ahead = step * 30_000 - Date.now();
  if (ahead > 29_000) await new Promise((done) => setTimeout(done, ahead - 29_000));
  lastStep = step;
  return totpCode(totpSecret, step * 30_000);
}

// A code field holds six digits and no more, so a second value has to replace the first.
async function enter(field, value) {
  await field.focus();
  for (let digit = 0; digit < 6; digit += 1) await field.press('Backspace');
  await field.pressSequentially(value);
}

// The address an application sends the browser to when it asks Identity to sign someone in.
function authorizationRequest(id, callback) {
  return `${origin}/auth?` + new URLSearchParams({ client_id: id, redirect_uri: callback, response_type: 'code', scope: 'openid orgs', state: 's',
    code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'), code_challenge_method: 'S256' });
}

async function noOverflow(page, label) {
  const sizes = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
  assert.ok(sizes.content <= sizes.viewport, `${label}: the page is ${sizes.content}px wide in a ${sizes.viewport}px viewport`);
}

async function choose(page, label, option) {
  // A list that is still closing stays in the page for a moment.
  await page.waitForFunction(() => !document.querySelector('[role="listbox"]'));
  await page.getByRole('button', { name: label }).click();
  await page.getByRole('option', { name: option }).click();
  await page.waitForFunction(() => !document.querySelector('[role="listbox"]'));
}

// With outgoing mail the sign-in page starts by offering a code, and the password is one link away.
async function usePassword(page) {
  await page.getByLabel('Email').waitFor();
  const link = page.getByRole('link', { name: 'Use password' });
  if (await link.count()) await link.click();
}

async function signInWithCode(page, person) {
  await page.goto(origin + '/login');
  await page.getByLabel('Email').fill(person.email);
  const sent = Date.now();
  await page.getByRole('button', { name: 'Send code' }).click();
  await enter(page.getByLabel('Verification code'), await codeIn(person.email, sent));
  await page.getByRole('heading', { level: 1, name: 'Applications' }).waitFor();
}

async function signIn(page, person, path = '/login') {
  await page.goto(origin + path);
  await usePassword(page);
  await page.getByLabel('Email').fill(person.email);
  await page.getByRole('textbox', { name: /^Password/ }).fill(person.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { level: 1, name: 'Applications' }).waitFor();
}

async function setupLink() {
  const html = await (await fetch(launcher)).text();
  const link = /https:\/\/identity\.localhost:\d+\/setup#[\w-]{43}/.exec(html)?.[0];
  assert.ok(link, 'The instance is already initialized. Start from a fresh state directory and database volume.');
  return link;
}

const owner = await session();
let adaPage;
let invitationLink;
// The path of the team the owner runs, used by the later journeys.
let operations;

await journey('an invalid setup link says how to get a new one', async () => {
  const page = await session();
  await page.goto(origin + '/setup#' + 'x'.repeat(43));
  await page.getByText('identity setup link').waitFor();
  await page.context().close();
});

await journey('setup wizard: owner, mail test, finish', async () => {
  await owner.goto(await setupLink());
  await owner.getByRole('heading', { name: 'Create the instance owner' }).waitFor();
  const hint = owner.locator('[data-password-state]');
  assert.match(await hint.innerText(), /^12 characters or more$/);
  await owner.getByLabel('Email').fill(people.owner.email);
  await owner.getByRole('textbox', { name: /^Password/ }).fill('short');
  assert.match(await hint.innerText(), /7 more to go/);
  assert.equal(await owner.getByRole('textbox', { name: /^Password/ }).getAttribute('autocomplete'), 'new-password');
  await owner.getByRole('textbox', { name: /^Password/ }).fill(people.owner.password);
  assert.equal(await hint.getAttribute('data-password-state'), 'met');
  await owner.screenshot({ path: join(shots, 'setup-owner.png'), fullPage: true });
  await owner.getByRole('button', { name: 'Create owner account' }).click();

  await owner.getByRole('heading', { name: 'Set up outgoing mail' }).waitFor();
  await owner.getByLabel('SMTP server').fill('127.0.0.1');
  await owner.getByLabel('Port').fill('1');
  await choose(owner, /Encryption/, /None/);
  await owner.getByLabel('Sender address').fill('identity@example.test');
  await owner.getByRole('button', { name: 'Send test message' }).click();
  await owner.getByText('The test message could not be sent').waitFor();
  await owner.getByLabel('Port').fill(smtpPort);
  await owner.screenshot({ path: join(shots, 'setup-mail.png'), fullPage: true });
  const sent = Date.now();
  await owner.getByRole('button', { name: 'Send test message' }).click();
  await owner.getByRole('status').filter({ hasText: `accepted the test message for ${people.owner.email}` }).waitFor();
  await owner.getByText('look for a bounce notice in the sender’s mailbox').waitFor();
  await enter(owner.getByLabel('Code from the test message'), '000000');
  await owner.getByRole('button', { name: 'Confirm and save' }).click();
  await owner.getByText('The code is incorrect or has expired').waitFor();
  await enter(owner.getByLabel('Code from the test message'), await codeIn(people.owner.email, sent));
  await owner.getByRole('button', { name: 'Confirm and save' }).click();

  await owner.getByRole('heading', { name: 'Finish setup' }).waitFor();
  await owner.getByText('Configured and tested').waitFor();
  // Reloading the link resumes at the step the instance has reached.
  await owner.reload();
  await owner.getByRole('heading', { name: 'Finish setup' }).waitFor();
  await owner.getByRole('button', { name: 'Finish setup' }).click();
  await owner.getByRole('heading', { name: 'Identity is ready' }).waitFor();
  await owner.screenshot({ path: join(shots, 'setup-done.png'), fullPage: true });
  await owner.getByRole('link', { name: 'Turn on two-step verification' }).click();
  await owner.waitForURL(origin + '/workspace/account#security');
  await expect(owner).toHaveTitle('Account · Account center · Niltavi Identity');
});

await journey('two-step verification: QR code, manual key, enable', async () => {
  await owner.getByRole('button', { name: 'Set up two-step verification' }).click();
  const qr = owner.getByRole('img', { name: 'QR code for your authenticator app' });
  await qr.waitFor();
  assert.match(await qr.getAttribute('src'), /^data:image\/png;base64,/);
  totpSecret = await owner.locator('[data-secret="totp-secret"]').innerText();
  assert.match(totpSecret, /^[A-Z2-7]{32}$/);
  await owner.screenshot({ path: join(shots, 'security-setup.png'), fullPage: true });
  await enter(owner.getByLabel('6-digit code from the app'), '000000');
  await owner.getByRole('button', { name: 'Turn on' }).click();
  await owner.getByText('The code is incorrect or has expired').waitFor();
  await enter(owner.getByLabel('6-digit code from the app'), await authenticatorCode());
  await owner.getByRole('button', { name: 'Turn on' }).click();
  await owner.getByText('Two-step verification is on.').waitFor();
});

await journey('console write: register an application, credentials shown once', async () => {
  await owner.goto(origin + '/workspace');
  await expect(owner.getByRole('banner').getByText('Instance console')).toHaveCount(0);
  await expect(owner.getByRole('navigation', { name: 'Account navigation' }).getByRole('link', { name: 'Instance console' })).toHaveCount(0);
  await owner.getByRole('button', { name: 'Account menu' }).press('Enter');
  const consoleLink = owner.getByRole('menuitem', { name: 'Instance console' });
  await expect(consoleLink).toHaveAttribute('href', '/admin');
  await consoleLink.press('Enter');
  await owner.waitForURL(origin + '/admin');
  assert.equal(await owner.evaluate(() => performance.getEntriesByType('navigation')[0].name), origin + '/workspace');
  // Each console page is named by its own heading and title, and the header says which role this is.
  await owner.getByRole('heading', { level: 1, name: 'Overview' }).waitFor();
  await expect(owner).toHaveTitle('Overview · Instance console · Niltavi Identity');
  await expect(owner.getByRole('banner').getByText('Instance console', { exact: true })).toBeVisible();
  await expect(owner.getByRole('banner').getByRole('link', { name: 'Identity', exact: true })).toHaveAttribute('href', '/admin');
  await owner.getByText('You are the owner').waitFor();
  assert.equal(await owner.getByText('Outgoing mail is not configured').count(), 0);
  const navigation = owner.getByRole('navigation', { name: 'Instance console navigation' });
  await expect(navigation.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  const sidebar = await navigation.boundingBox();
  const content = await owner.getByRole('main').boundingBox();
  assert.ok(sidebar && content && sidebar.x + sidebar.width <= content.x);
  await expect(navigation.getByRole('link', { name: 'Account center' })).toHaveCount(0);
  await navigation.getByRole('link', { name: 'Applications' }).click();
  await owner.waitForURL(origin + '/admin/applications');
  await expect(navigation.getByRole('link', { name: 'Applications' })).toHaveAttribute('aria-current', 'page');
  await owner.getByRole('heading', { level: 1, name: 'Applications' }).waitFor();
  await expect(owner).toHaveTitle('Applications · Instance console · Niltavi Identity');
  await owner.getByLabel('Application ID').fill(`notes-${run}`);
  await owner.getByLabel('Name').fill('Notes');
  await owner.getByLabel('Address (https://…)').fill(`https://notes-${run}.example.test/`);
  await owner.getByRole('button', { name: 'Register application' }).click();
  await owner.getByText('Application registered').waitFor();
  assert.equal(await owner.locator('[data-secret="client-id"]').innerText(), `notes-${run}`);
  assert.match(await owner.locator('[data-secret="client-secret"]').innerText(), /^[\w-]{43}$/);
  await owner.screenshot({ path: join(shots, 'admin-applications.png'), fullPage: true });
  await owner.getByRole('button', { name: 'Done' }).click();
  assert.equal(await owner.locator('[data-secret="client-secret"]').count(), 0);
  await owner.locator(`[data-application="notes-${run}"]`).getByRole('button', { name: 'Disable' }).click();
  await owner.locator(`[data-application="notes-${run}"]`).getByText('Disabled').waitFor();
  // Admin pages have direct links and participate in browser history.
  await owner.goto(origin + '/admin/audit');
  await owner.getByRole('grid', { name: 'Audit log' }).waitFor();
  await owner.getByText('Application registered').first().waitFor();
  await navigation.getByRole('link', { name: 'Teams' }).click();
  await owner.waitForURL(origin + '/admin/teams');
  await owner.goBack();
  await owner.getByRole('grid', { name: 'Audit log' }).waitFor();
  await expect(navigation.getByRole('link', { name: 'Audit log' })).toHaveAttribute('aria-current', 'page');
  await owner.goForward();
  await expect(navigation.getByRole('link', { name: 'Teams' })).toHaveAttribute('aria-current', 'page');
});

await journey('console navigation opens from the left and works by keyboard on mobile', async () => {
  const page = await session({ viewport: { width: 320, height: 800 }, colorScheme: 'dark' });
  await page.context().addCookies(await owner.context().cookies());
  await page.goto(origin + '/zh/admin/mail');
  await page.getByRole('heading', { level: 1, name: '发信' }).waitFor();
  await expect(page).toHaveTitle('发信 · 实例管理台 · Niltavi Identity');
  // A phone has no room for the role tag beside the wordmark, so it sits above the heading and the name stays whole.
  await expect(page.getByRole('banner').getByText('实例管理台', { exact: true })).toBeHidden();
  await expect(page.getByRole('main').getByText('实例管理台', { exact: true })).toBeVisible();
  assert.ok(await page.locator('.niltavi-project-brand__name').evaluate(node => node.scrollWidth <= node.clientWidth), 'The product name is not cut off');
  const trigger = page.getByRole('button', { name: '打开实例管理台导航' });
  await trigger.press('Enter');
  const drawer = page.getByRole('dialog', { name: '实例管理台' });
  await expect(drawer.getByRole('link', { name: '发信' })).toHaveAttribute('aria-current', 'page');
  await expect(drawer).toHaveAttribute('data-placement', 'left');
  await noOverflow(page, 'console navigation at 320px');
  await page.screenshot({ path: join(shots, 'admin-mobile-sidebar.png'), animations: 'disabled' });
  await drawer.getByRole('link', { name: '团队' }).press('Enter');
  await page.waitForURL(origin + '/zh/admin/teams');
  assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation')[0].name), origin + '/zh/admin/mail');
  await drawer.waitFor({ state: 'hidden' });
  await expect(trigger).toBeFocused();
  await page.getByRole('button', { name: '语言', exact: true }).click();
  await page.getByRole('menuitem', { name: 'English' }).click();
  await page.waitForURL(origin + '/admin/teams');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  const englishTrigger = page.getByRole('button', { name: 'Open instance console navigation' });
  await page.setViewportSize({ width: 767, height: 800 });
  await expect(englishTrigger).toBeVisible();
  await page.setViewportSize({ width: 768, height: 800 });
  await expect(englishTrigger).toBeHidden();
  await expect(page.getByRole('banner').getByText('Instance console', { exact: true })).toBeVisible();
  await expect(page.getByRole('main').getByText('Instance console', { exact: true })).toBeHidden();
  const navigation = page.getByRole('navigation', { name: 'Instance console navigation' });
  await expect(navigation.getByRole('link', { name: 'Teams' })).toHaveAttribute('aria-current', 'page');
  await noOverflow(page, 'console navigation at 768px');
  await page.setViewportSize({ width: 320, height: 800 });
  await englishTrigger.press('Enter');
  await page.getByRole('dialog', { name: 'Instance console' }).getByRole('button', { name: 'Account menu' }).press('Enter');
  await page.getByRole('menuitem', { name: 'Account center' }).press('Enter');
  await page.waitForURL(origin + '/workspace');
  await page.context().close();
});

await journey('console scrolls the content without moving the header or navigation', async () => {
  for (const width of [320, 1280]) {
    const page = await session({ viewport: { width, height: 420 }, colorScheme: width === 320 ? 'dark' : 'light' });
    await page.context().addCookies(await owner.context().cookies());
    await page.goto(origin + '/admin/applications');
    await page.getByRole('button', { name: 'Register application' }).waitFor({ state: 'attached' });
    const content = page.getByRole('main');
    const header = page.getByRole('banner');
    const trigger = page.getByRole('button', { name: 'Open instance console navigation' });
    const navigation = width === 320 ? trigger : page.getByRole('navigation', { name: 'Instance console navigation' });
    const headerBefore = await header.boundingBox();
    const navigationBefore = await navigation.boundingBox();
    assert.ok(await content.evaluate(node => node.scrollHeight > node.clientHeight));
    await content.hover();
    await page.mouse.wheel(0, 240);
    await expect.poll(() => content.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await content.press('End');
    await expect.poll(() => content.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2);
    assert.deepEqual(await header.boundingBox(), headerBefore);
    assert.deepEqual(await navigation.boundingBox(), navigationBefore);
    assert.ok(await page.evaluate(() => {
      const doc = document.scrollingElement;
      return doc.scrollTop === 0 && doc.scrollHeight === doc.clientHeight;
    }));

    if (width === 320) await trigger.click();
    await page.getByRole('navigation', { name: 'Instance console navigation' }).getByRole('link', { name: 'Audit log' }).click();
    await page.waitForURL(origin + '/admin/audit');
    await expect.poll(() => content.evaluate(node => node.scrollTop)).toBe(0);
    await page.context().close();
  }
});

await journey('account center has no site footer and scrolls within the content area', async () => {
  for (const width of [320, 1280]) {
    const mobile = width === 320;
    const page = await session({ viewport: { width, height: 360 }, colorScheme: mobile ? 'dark' : 'light' });
    await page.context().addCookies(await owner.context().cookies());
    const workspace = origin + (mobile ? '/zh/workspace' : '/workspace');
    await page.goto(workspace + '/account');
    await page.getByRole('heading', { level: 1, name: mobile ? '账号' : 'Account' }).waitFor();
    await expect(page.getByRole('contentinfo')).toHaveCount(0);
    await noOverflow(page, 'account center');

    const content = page.getByRole('main');
    const header = page.getByRole('banner');
    const trigger = page.getByRole('button', { name: '打开账号中心导航' });
    const sidebarControl = mobile ? trigger : page.getByRole('button', { name: 'Account menu' });
    const headerBefore = await header.boundingBox();
    const sidebarBefore = await sidebarControl.boundingBox();
    await content.press('End');
    await expect.poll(() => content.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    assert.deepEqual(await header.boundingBox(), headerBefore);
    assert.deepEqual(await sidebarControl.boundingBox(), sidebarBefore);
    assert.ok(await page.evaluate(() => {
      const doc = document.scrollingElement;
      return doc.scrollTop === 0 && doc.scrollHeight === doc.clientHeight;
    }));

    if (mobile) await trigger.click();
    const navigation = page.getByRole('navigation', { name: mobile ? '账号中心导航' : 'Account navigation' });
    await navigation.getByRole('link', { name: mobile ? '团队' : 'Teams' }).click();
    await page.waitForURL(workspace + '/teams');
    await expect.poll(() => content.evaluate(node => node.scrollTop)).toBe(0);
    await page.context().close();
  }
});

await journey('register with mail: password errors only after validation, 6-digit code, signed in', async () => {
  adaPage = await session();
  await adaPage.goto(origin + '/register');
  await adaPage.getByRole('heading', { name: 'Create an account' }).waitFor();
  assert.equal(await adaPage.getByText('12 characters or more').count(), 0);
  await adaPage.getByLabel('Email').fill(people.ada.email);
  await adaPage.getByRole('textbox', { name: /^Password/ }).fill('abcdefghijk');
  assert.equal(await adaPage.getByText('12 characters or more').count(), 0);
  await adaPage.getByRole('button', { name: 'Create account' }).click();
  await adaPage.getByText('12 characters or more').waitFor();
  await adaPage.getByRole('textbox', { name: /^Password/ }).fill('password1234');
  await adaPage.getByText('12 characters or more').waitFor({ state: 'hidden' });
  await adaPage.getByRole('button', { name: 'Create account' }).click();
  await adaPage.getByText('too easy to guess').waitFor();
  await adaPage.getByRole('textbox', { name: /^Password/ }).fill(people.ada.password);
  const sent = Date.now();
  await adaPage.getByRole('button', { name: 'Create account' }).click();
  await adaPage.getByRole('heading', { name: 'Check your email' }).waitFor();
  await adaPage.screenshot({ path: join(shots, 'register-code.png'), fullPage: true });
  // The pending registration survives a reload.
  await adaPage.reload();
  await adaPage.getByRole('heading', { name: 'Check your email' }).waitFor();
  await enter(adaPage.getByLabel('Verification code'), await codeIn(people.ada.email, sent));
  await adaPage.waitForURL(origin + '/workspace');
  await adaPage.getByRole('heading', { level: 1, name: 'Applications' }).waitFor();
  await expect(adaPage).toHaveTitle('Applications · Account center · Niltavi Identity');
  // Nothing in the navigation points at a team until the account runs one.
  await expect(adaPage.getByRole('navigation', { name: 'Account navigation' }).getByText('Teams you manage')).toHaveCount(0);
  await adaPage.getByRole('button', { name: 'Account menu' }).press('Enter');
  const menu = adaPage.getByRole('menu', { name: 'Account menu' });
  await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Instance console' })).toHaveCount(0);
  await adaPage.goto(origin + '/admin/accounts');
  await adaPage.getByText('Only instance administrators can open the console.').waitFor();
  await expect(adaPage.getByRole('navigation', { name: 'Instance console navigation' })).toHaveCount(0);
  assert.equal((await adaPage.request.get(origin + '/admin/api/accounts')).status(), 403);
  await adaPage.getByRole('link', { name: 'Back to your account' }).click();
  await adaPage.waitForURL(origin + '/workspace');
});

await journey('account page: profile, security, sessions and deletion in one place', async () => {
  await adaPage.getByRole('link', { name: 'Account', exact: true }).click();
  await adaPage.waitForURL(origin + '/workspace/account');
  for (const name of ['Profile', 'Sign-in and security', 'Sessions', 'Delete account']) {
    await adaPage.getByRole('heading', { level: 2, name, exact: true }).waitFor();
  }
  await adaPage.getByText('Verified', { exact: true }).waitFor();
  const accountNavigation = adaPage.getByRole('navigation', { name: 'Account navigation' });
  await expect(accountNavigation.getByRole('link', { name: 'Account', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(accountNavigation.locator('[aria-current]')).toHaveCount(1);
  await adaPage.mouse.move(640, 450);
  await adaPage.screenshot({ path: join(shots, 'account.png'), fullPage: true });
  await adaPage.getByLabel('Display name').fill('Ada L.');
  await adaPage.getByRole('button', { name: 'Save' }).click();
  await adaPage.getByText('Profile saved.').waitFor();
  await adaPage.reload();
  await adaPage.getByRole('button', { name: 'Account menu' }).getByText('Ada L.').waitFor();
});

await journey('teams: personal space first, create a team, invite by email', async () => {
  await adaPage.getByRole('link', { name: 'Teams' }).click();
  await adaPage.waitForURL(origin + '/workspace/teams');
  await adaPage.getByText('Personal space').waitFor();
  await adaPage.getByLabel('Team name').fill('Acme Research');
  await adaPage.getByRole('button', { name: 'Create team' }).click();
  await adaPage.waitForURL(/\/workspace\/teams\/[\w-]+$/);
  await expect(adaPage.locator('[data-team-name]')).toHaveText('Acme Research');
  await adaPage.getByRole('heading', { level: 1, name: 'Members' }).waitFor();
  // Running a team adds it to the navigation, opened to its own pages.
  const managed = adaPage.getByRole('navigation', { name: 'Account navigation' });
  await managed.getByText('Teams you manage').waitFor();
  await expect(managed.getByRole('button', { name: 'Acme Research' })).toHaveAttribute('aria-expanded', 'true');
  await expect(managed.getByRole('link', { name: 'Members' })).toHaveAttribute('aria-current', 'page');
  for (const name of ['Applications', 'Agent tokens', 'Audit log', 'Settings']) await expect(managed.getByRole('link', { name })).not.toHaveCount(0);
  await adaPage.getByLabel('Email').fill(people.ben.email);
  await adaPage.getByRole('button', { name: 'Invite', exact: true }).click();
  await adaPage.getByText(`We emailed the invitation to ${people.ben.email}.`).waitFor();
  invitationLink = await adaPage.locator('[data-secret="invitation-link"]').innerText();
  assert.match(invitationLink, new RegExp(`^${origin}/invite#[\\w-]{43}$`));
  await adaPage.getByRole('button', { name: 'Copy', exact: true }).click();
  await adaPage.getByRole('button', { name: 'Copied' }).waitFor();
  await adaPage.getByText('Waiting for a reply').waitFor();
  await adaPage.screenshot({ path: join(shots, 'team-detail.png'), fullPage: true });
  // The only owner cannot leave: the control is unavailable until another owner exists.
  await adaPage.getByRole('button', { name: 'Done' }).click();
});

await journey('invitation: create the account from the link, verify, accept', async () => {
  const page = await session();
  await page.goto(invitationLink);
  await page.getByRole('heading', { name: 'Join Acme Research' }).waitFor();
  await page.getByText(`invited ${people.ben.email} to join Acme Research as member`).waitFor();
  await page.screenshot({ path: join(shots, 'invite-signed-out.png'), fullPage: true });
  // With outgoing mail the invited address proves itself with a code, and the account needs no password.
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(origin + '/login');
  await page.getByLabel('Email').fill(people.ben.email);
  const sent = Date.now();
  await page.getByRole('button', { name: 'Send code' }).click();
  await enter(page.getByLabel('Verification code'), await codeIn(people.ben.email, sent));
  // A verified address that matches the invitation joins without another click.
  await page.waitForURL(/\/workspace\/teams\/[\w-]+$/);
  await expect(page.locator('[data-team-name]')).toHaveText('Acme Research');
  await page.locator(`[data-member="${people.ben.email}"]`).getByText('You').waitFor();
  // A member sees no invitation controls, no role controls, and no pages for running the team.
  assert.equal(await page.getByRole('button', { name: 'Invite', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: /Role of/ }).count(), 0);
  await expect(page.getByRole('navigation', { name: 'Account navigation' }).getByText('Teams you manage')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Account navigation' }).getByRole('link', { name: 'Teams', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.goto(page.url() + '/applications');
  await page.getByText('Only team owners and admins can do this.').waitFor();
  await page.goBack();
  // The used link now says so.
  await page.goto(invitationLink);
  await page.getByText('was already accepted').waitFor();
  await page.context().close();
});

await journey('team roles: last owner is protected, promote, remove', async () => {
  await adaPage.reload();
  const ben = adaPage.locator(`[data-member="${people.ben.email}"]`);
  await ben.waitFor();
  await adaPage.getByText('You are the only owner').waitFor();
  assert.ok(await adaPage.getByRole('button', { name: 'Leave team' }).isDisabled());
  // Demoting the only owner is refused with a clear reason.
  await choose(adaPage, new RegExp(`Role of ${people.ada.email}`), 'Member');
  await adaPage.getByText('A team needs an owner').waitFor();
  await choose(adaPage, new RegExp(`Role of ${people.ben.email}`), 'Admin');
  await adaPage.getByRole('button', { name: new RegExp(`Admin.*Role of ${people.ben.email}|Role of ${people.ben.email}.*Admin`) }).waitFor();
  await ben.getByRole('button', { name: 'Remove' }).click();
  await ben.getByRole('button', { name: 'Confirm removal' }).click();
  await ben.waitFor({ state: 'detached' });
});

await journey('agent tokens: create, shown once, revoke', async () => {
  await adaPage.getByRole('link', { name: 'Agent tokens' }).first().click();
  await adaPage.waitForURL(origin + '/workspace/tokens');
  await adaPage.getByText('No tokens yet.').waitFor();
  for (const name of ['laptop agent', 'ci agent']) {
    await adaPage.getByLabel('Name').fill(name);
    if (name === 'ci agent') await choose(adaPage, /Valid for/, 'No expiry');
    await adaPage.getByRole('button', { name: 'Create token' }).click();
    await adaPage.locator(`[data-token="${name}"]`).waitFor();
    assert.match(await adaPage.locator('[data-secret="agent-token"]').innerText(), /^nvt_[\w-]{43}$/);
  }
  await adaPage.screenshot({ path: join(shots, 'tokens.png'), fullPage: true });
  await adaPage.getByRole('button', { name: 'Done' }).click();
  await adaPage.reload();
  assert.equal(await adaPage.locator('[data-secret="agent-token"]').count(), 0);
  await adaPage.locator('[data-token="ci agent"]').getByText('no expiry').waitFor();
  const first = adaPage.locator('[data-token="laptop agent"]');
  await first.getByRole('button', { name: 'Revoke' }).click();
  await first.getByRole('button', { name: 'Confirm revoke' }).click();
  await first.waitFor({ state: 'detached' });
});

await journey('recover and reset by mail: same answer for any address, tokens offered for revocation', async () => {
  const page = await session();
  await page.goto(origin + '/login');
  await usePassword(page);
  await page.getByRole('link', { name: 'Forgot password' }).click();
  await page.waitForURL(origin + '/recover');
  await page.getByLabel('Email').fill(`nobody-${run}@example.test`);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  const unknown = await page.locator('.nt-auth__done').innerText();
  await page.goto(origin + '/recover');
  await page.getByLabel('Email').fill(people.ada.email);
  const sent = Date.now();
  await page.getByRole('button', { name: 'Send reset link' }).click();
  const known = await page.locator('.nt-auth__done').innerText();
  assert.equal(known.replace(people.ada.email, '@'), unknown.replace(`nobody-${run}@example.test`, '@'));
  const link = await mail(people.ada.email, new RegExp(`${origin}/reset#[\\w-]{43}`), sent);
  await page.goto(link);
  await page.getByRole('heading', { name: 'Choose a new password' }).waitFor();
  assert.match(await page.locator('[data-password-state]').innerText(), /^12 characters or more$/);
  people.ada.password = password();
  await page.getByLabel('New password').fill(people.ada.password);
  await page.getByRole('button', { name: 'Change password' }).click();
  await page.getByRole('heading', { name: 'Password changed' }).waitFor();
  await page.screenshot({ path: join(shots, 'reset-tokens.png'), fullPage: true });
  await page.getByText(/ci agent/).click();
  assert.ok(await page.getByRole('checkbox', { name: /ci agent/ }).isChecked());
  await page.getByRole('button', { name: 'Revoke selected' }).click();
  await page.getByText('The selected tokens were revoked.').waitFor();
  await page.getByRole('link', { name: 'Continue to your account' }).click();
  await page.waitForURL(origin + '/workspace');
  await page.getByRole('link', { name: 'Agent tokens' }).first().click();
  await page.getByText('No tokens yet.').waitFor();
  // The link works once.
  await page.goto(origin + '/login');
  await page.goto(link);
  await page.reload();
  await page.getByLabel('New password').fill(password());
  await page.getByRole('button', { name: 'Change password' }).click();
  await page.getByText('The reset link is invalid, expired, or already used.').waitFor();
  await page.getByRole('link', { name: 'Request a new link' }).waitFor();
  await page.context().close();
  // The earlier browser was signed out by the reset and lands on sign-in.
  // An address from before the account pages were merged still works, through sign-in and back.
  await adaPage.goto(origin + '/workspace/sessions');
  await adaPage.waitForURL(origin + '/login');
  await usePassword(adaPage);
  await adaPage.getByLabel('Email').fill(people.ada.email);
  await adaPage.getByRole('textbox', { name: /^Password/ }).fill('not-the-password');
  await adaPage.getByRole('button', { name: 'Sign in' }).click();
  await adaPage.getByText('The email or password is incorrect.').waitFor();
  await adaPage.getByRole('textbox', { name: /^Password/ }).fill(people.ada.password);
  await adaPage.getByRole('button', { name: 'Sign in' }).click();
  // Signing in returns to the page that asked for it.
  await adaPage.waitForURL(origin + '/workspace/account#sessions');
  await expect(adaPage.getByRole('heading', { level: 2, name: 'Sessions' })).toBeInViewport();
});

await journey('sessions: list, sign-out scopes, sign out of all devices', async () => {
  await adaPage.getByText('This browser', { exact: true }).waitFor();
  await adaPage.getByRole('button', { name: 'Account menu' }).waitFor();
  await adaPage.getByText('Sign out of this app').waitFor();
  await adaPage.screenshot({ path: join(shots, 'sessions.png'), fullPage: true });
  await adaPage.getByRole('button', { name: 'Sign out of all devices' }).click();
  await adaPage.getByRole('button', { name: 'Confirm: sign out everywhere' }).click();
  await adaPage.waitForURL(origin + '/login');
});

await journey('console is read-only in a new session until a code unlocks it', async () => {
  const page = await session();
  await signIn(page, people.owner);
  await page.goto(origin + '/admin/mail');
  await page.getByText('To make changes, enter a code').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Remove mail settings' }).count(), 0);
  await page.screenshot({ path: join(shots, 'admin-locked.png'), fullPage: true });
  await enter(page.getByLabel('Verification code'), await authenticatorCode());
  await page.getByRole('button', { name: 'Unlock changes' }).click();
  await page.getByRole('button', { name: 'Remove mail settings' }).waitFor();
  await page.context().close();
});

await journey('console: remove outgoing mail, banner appears on every page', async () => {
  await owner.goto(origin + '/zh/admin/mail');
  await owner.getByRole('button', { name: '移除发信配置' }).click();
  await owner.getByRole('button', { name: '确认移除' }).click();
  await owner.getByText('未配置发信。').waitFor();
  await owner.screenshot({ path: join(shots, 'admin-mail-none-zh.png'), fullPage: true });
  const navigation = owner.getByRole('navigation', { name: '实例管理台导航' });
  for (const label of ['概览', '账号', '团队', '应用', '审计日志']) {
    await navigation.getByRole('link', { name: label, exact: true }).click();
    await owner.getByText('未配置发信。').waitFor();
    await owner.getByRole('link', { name: '配置发信' }).waitFor();
  }
});

await journey('register without mail (Chinese): signed in at once, address unverified', async () => {
  const page = await session();
  await page.goto(origin + '/zh/register');
  await page.getByRole('heading', { name: '创建账号' }).waitFor();
  assert.equal(await page.getByText('至少 12 个字符').count(), 0);
  await page.screenshot({ path: join(shots, 'Z-255-registration.png') });
  await page.getByLabel('邮箱').fill(people.cy.email);
  await page.getByRole('textbox', { name: /^密码/ }).fill('abcdefghijk');
  assert.equal(await page.getByText('至少 12 个字符').count(), 0);
  await page.getByRole('button', { name: '创建账号' }).click();
  await page.getByText('至少 12 个字符').waitFor();
  await page.screenshot({ path: join(shots, 'Z-255-password-error.png') });
  await page.getByRole('textbox', { name: /^密码/ }).fill(people.cy.password);
  await page.getByText('至少 12 个字符').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '创建账号' }).click();
  await page.waitForURL(origin + '/zh/workspace');
  await page.getByRole('heading', { level: 1, name: '应用' }).waitFor();
  await page.screenshot({ path: join(shots, 'workspace-zh.png'), fullPage: true });
  await page.getByRole('link', { name: '账号', exact: true }).click();
  await page.waitForURL(origin + '/zh/workspace/account');
  await expect(page).toHaveTitle('账号 · 账号中心 · Niltavi Identity');
  await page.getByText('未验证').waitFor();
  await page.getByText('此实例无法发信，请联系管理员为你验证邮箱。').waitFor();
  // Without outgoing mail there is no code to send, so the address cannot be changed here.
  await expect(page.getByRole('button', { name: '更改邮箱' })).toHaveCount(0);
  const locale = page.getByRole('button', { name: /邮件链接语言/ });
  assert.match(await locale.innerText(), /跟随浏览器/);
  await choose(page, /邮件链接语言/, 'English');
  await page.getByText('邮件链接语言已保存。').waitFor();
  await page.reload();
  await locale.waitFor();
  assert.match(await locale.innerText(), /English/);
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  await page.screenshot({ path: join(shots, 'Z-256-email-language.png') });
  const menu = page.getByRole('button', { name: '账号菜单' });
  await menu.focus();
  await menu.press('Enter');
  await page.getByRole('menuitem', { name: '退出登录' }).waitFor();
  await page.screenshot({ path: join(shots, 'Z-254-desktop-sidebar.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  const desktop = await session();
  await signIn(desktop, people.cy);
  const desktopMenu = desktop.getByRole('button', { name: 'Account menu' });
  await desktopMenu.focus();
  await desktopMenu.press('Enter');
  await desktop.getByRole('menuitem', { name: 'Sign out' }).press('Enter');
  await desktop.waitForURL(origin + '/login');
  await desktop.context().close();
  await page.setViewportSize({ width: 320, height: 800 });
  await page.getByRole('button', { name: '打开账号中心导航' }).click();
  const drawer = page.getByRole('dialog', { name: '账号中心' });
  await drawer.getByRole('link', { name: '团队' }).click();
  await page.waitForURL(origin + '/zh/workspace/teams');
  await drawer.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '打开账号中心导航' }).click();
  await drawer.getByRole('button', { name: '账号菜单' }).click();
  const signOut = page.getByRole('menuitem', { name: '退出登录' });
  await signOut.waitFor();
  await expect(signOut).toBeInViewport();
  await signOut.evaluate(async node => {
    await new Promise(requestAnimationFrame);
    await Promise.allSettled(node.closest('[data-placement]')?.getAnimations({ subtree: true }).map(animation => animation.finished) ?? []);
  });
  await noOverflow(page, 'account menu at 320px');
  await page.screenshot({ path: join(shots, 'Z-254-mobile-sidebar.png') });
  await signOut.click();
  await page.waitForURL(origin + '/zh/login');
  await page.getByRole('link', { name: '忘记密码' }).click();
  await page.getByText('此实例无法发送邮件。请联系管理员为你生成密码重置链接。').waitFor();
  await page.context().close();
});

await journey('console accounts: search, verify email, reset link shown once, disable, delete', async () => {
  await owner.goto(origin + '/admin/accounts');
  await owner.getByLabel('Search by email or name').fill(`cy-${run}`);
  await owner.getByRole('button', { name: 'Search' }).click();
  const row = owner.locator(`[data-account="${people.cy.email}"]`);
  await row.getByText('Not verified').waitFor();
  assert.equal(await owner.locator('[data-account]').count(), 1);
  const act = async (name) => {
    await row.getByRole('button', { name: `Manage ${people.cy.email}` }).click();
    await owner.getByRole('menuitem', { name }).click();
  };
  await act('Mark email as verified');
  await row.getByText('Verified', { exact: true }).waitFor();
  await act('Create password reset link');
  const link = await owner.locator('[data-secret="reset-link"]').innerText();
  assert.match(link, new RegExp(`^${origin}/reset#[\\w-]{43}$`));
  await owner.screenshot({ path: join(shots, 'admin-accounts.png'), fullPage: true });
  const page = await session();
  await page.goto(link);
  people.cy.password = password();
  await page.getByLabel('New password').fill(people.cy.password);
  await page.getByRole('button', { name: 'Change password' }).click();
  await page.getByRole('heading', { name: 'Password changed' }).waitFor();
  // The account holder asks for deletion. The console lists that request first.
  await page.getByRole('link', { name: 'Continue to your account' }).click();
  await page.goto(origin + '/workspace/settings/account');
  await page.waitForURL(origin + '/workspace/account#delete');
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: 'Delete account' })).toBeInViewport();
  await page.getByRole('button', { name: 'Delete account' }).click();
  await page.getByLabel('Current password').fill('not-the-password');
  await page.getByRole('button', { name: 'Confirm deletion' }).click();
  await page.getByText('Your current password is incorrect.').waitFor();
  await page.getByLabel('Current password').fill(people.cy.password);
  await page.getByRole('button', { name: 'Confirm deletion' }).click();
  await page.getByText('This account will be deleted on').waitFor();
  await page.getByRole('button', { name: 'Keep my account' }).waitFor();
  await page.getByRole('button', { name: 'Language', exact: true }).click();
  await page.getByRole('menuitem', { name: '简体中文' }).click();
  await page.waitForURL(origin + '/zh/workspace/account#delete');
  await page.getByText('此账号将于').waitFor();
  await page.getByRole('menu').waitFor({ state: 'detached' });
  await page.screenshot({ path: join(shots, 'Z-257-deletion-request.png') });
  await owner.getByLabel('Search by email or name').fill('');
  await owner.getByRole('button', { name: 'Search' }).click();
  await owner.getByText('Asked to be deleted').waitFor();
  assert.equal(await owner.locator('[data-account]').first().getAttribute('data-account'), people.cy.email);
  await act('Disable account');
  await row.getByText('Disabled').waitFor();
  await page.reload();
  await page.waitForURL(origin + '/zh/login');
  await page.context().close();
  await act('Delete account');
  await row.getByRole('button', { name: 'Delete permanently' }).click();
  await owner.getByText('The account was deleted.').waitFor();
  assert.equal(await row.count(), 0);
});

await journey('sign in from an application: protocol page, wrong password, back to the app', async () => {
  const page = await session();
  const app = `https://flagstone.localhost:${base + 1}/tasks/42`;
  await page.goto(app);
  await page.getByRole('heading', { level: 1, name: 'Sign in' }).waitFor();
  await page.getByRole('link', { name: 'Create an account' }).waitFor();
  await page.getByRole('link', { name: 'Forgot password' }).waitFor();
  await page.screenshot({ path: join(shots, 'protocol-login.png'), fullPage: true });
  // Changing the language keeps the sign-in request.
  await page.getByRole('button', { name: 'Language', exact: true }).click();
  await page.getByRole('menuitem', { name: '简体中文' }).click();
  await page.getByRole('heading', { level: 1, name: '登录' }).waitFor();
  await page.getByLabel('邮箱').fill(people.ada.email);
  await page.getByRole('textbox', { name: /^密码/ }).fill('not-the-password');
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByText('邮箱或密码不正确。').waitFor();
  await page.getByLabel('邮箱').fill(people.ada.email);
  await page.getByRole('textbox', { name: /^密码/ }).fill(people.ada.password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL(app);
  await page.context().close();
});

await journey('application access: validate password, revoke one app, and sign in again', async () => {
  const page = await session();
  const flagstone = `https://flagstone.localhost:${base + 1}`;
  const wattlework = `https://wattlework.localhost:${base + 2}`;
  await signIn(page, people.ada);
  await page.goto(flagstone + '/tasks/42');
  await page.waitForURL(flagstone + '/tasks/42');
  await page.goto(wattlework + '/contracts/7');
  await page.waitForURL(wattlework + '/contracts/7');
  // The first screen is the launcher: a card per application, the ones already used first.
  await page.goto(origin + '/zh/workspace/applications');
  await page.waitForURL(origin + '/zh/workspace');
  const mine = page.locator('[data-apps="joined"]');
  await mine.getByRole('heading', { level: 2, name: '我的应用' }).waitFor();
  for (const [id, name, address] of [['flagstone-demo', 'Flagstone Demo', flagstone], ['wattlework-demo', 'Wattlework Demo', wattlework]]) {
    const card = mine.locator(`[data-application="${id}"]`);
    await card.getByRole('heading', { level: 3, name }).waitFor();
    await expect(card.getByRole('link', { name: `打开 ${name}` })).toHaveAttribute('href', address + '/');
  }
  await page.screenshot({ path: join(shots, 'launcher-zh.png'), fullPage: true });
  const revoke = page.getByRole('button', { name: '撤销 Flagstone Demo 的授权' });
  await revoke.waitFor();
  await page.getByRole('button', { name: '撤销 Wattlework Demo 的授权' }).waitFor();
  await revoke.click();
  const dialog = page.getByRole('dialog', { name: '撤销 Flagstone Demo 的授权？' });
  await dialog.getByLabel('当前密码').waitFor();
  await page.screenshot({ path: join(shots, 'Z-258-verify-access.png'), animations: 'disabled' });
  await dialog.getByRole('button', { name: '取消' }).click();
  await dialog.waitFor({ state: 'hidden' });
  const status = async (app) => (await page.request.get(app + '/api/me')).status();
  assert.equal(await status(flagstone), 200);
  await revoke.click();
  await dialog.getByLabel('当前密码').fill('wrong-password-value');
  await dialog.getByRole('button', { name: '撤销授权' }).click();
  await dialog.getByText('当前密码不正确。').waitFor();
  assert.equal(await status(flagstone), 200);
  await dialog.getByLabel('当前密码').fill(people.ada.password);
  await dialog.getByRole('button', { name: '撤销授权' }).click();
  await page.getByText('已撤销 Flagstone Demo 的授权。').waitFor();
  await revoke.waitFor({ state: 'detached' });
  // The application stays among the ones this account has used. Only the access is gone.
  await mine.locator('[data-application="flagstone-demo"]').waitFor();
  await page.screenshot({ path: join(shots, 'Z-258-revoked-access.png') });
  await expect.poll(() => status(flagstone)).toBe(401);
  assert.equal(await status(wattlework), 200);
  await page.goto(flagstone + '/tasks/42');
  await page.waitForURL(flagstone + '/tasks/42');
  assert.equal(await status(flagstone), 200);
  await page.context().close();
});

await journey('register from an application: straight back to the app, no extra page', async () => {
  const page = await session();
  const app = `https://wattlework.localhost:${base + 2}/contracts/7`;
  await page.goto(app);
  await page.getByRole('link', { name: 'Create an account' }).click();
  // Registration stays inside the sign-in request, so the application is where it ends.
  await page.waitForURL(/\/interaction\/[\w-]+\/register$/);
  await page.getByLabel('Email').fill(people.dee.email);
  await page.getByRole('textbox', { name: /^Password/ }).fill(people.dee.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(app);
  await page.context().close();
});

await journey('expired sign-in request offers the way back', async () => {
  const page = await session();
  const response = await page.goto(origin + '/interaction/' + 'a'.repeat(21));
  assert.equal(response.status(), 400);
  await page.getByRole('heading', { name: 'This sign-in request has expired' }).waitFor();
  await page.screenshot({ path: join(shots, 'protocol-expired.png'), fullPage: true });
  await page.context().close();
});

await journey('console: add outgoing mail again from the mail page', async () => {
  await owner.goto(origin + '/admin/mail');
  await owner.getByLabel('SMTP server').fill('127.0.0.1');
  await owner.getByLabel('Port').fill(smtpPort);
  await choose(owner, /Encryption/, /None/);
  await owner.getByLabel('Sender address').fill('identity@example.test');
  const sent = Date.now();
  await owner.getByRole('button', { name: 'Send test message' }).click();
  await enter(owner.getByLabel('Code from the test message'), await codeIn(people.owner.email, sent));
  await owner.getByRole('button', { name: 'Confirm and save' }).click();
  await owner.getByText('Working').waitFor();
  assert.equal(await owner.getByText('Outgoing mail is not configured').count(), 0);
  await owner.getByRole('navigation', { name: 'Instance console navigation' }).getByRole('link', { name: 'Overview' }).click();
  await choose(owner, /Who can register/, 'Invite-only');
  await owner.getByText('Registration setting saved.').waitFor();
  const page = await session();
  await page.goto(origin + '/register');
  await page.getByText('This instance is invite-only.').waitFor();
  await page.context().close();
  await choose(owner, /Who can register/, 'Open to everyone');
  await owner.getByText('Registration setting saved.').waitFor();
});

await journey('invitation: wrong account, then an unverified address verified by mail', async () => {
  await owner.goto(origin + '/workspace/teams');
  await owner.getByLabel('Team name').fill('Operations');
  await owner.getByRole('button', { name: 'Create team' }).click();
  await expect(owner.locator('[data-team-name]')).toHaveText('Operations');
  operations = new URL(owner.url()).pathname;
  await owner.getByLabel('Email').fill(people.dee.email);
  await choose(owner, /\bRole\b(?! of)/, 'Admin');
  await owner.getByRole('button', { name: 'Invite', exact: true }).click();
  const link = await owner.locator('[data-secret="invitation-link"]').innerText();
  const page = await session();
  await signIn(page, people.ada);
  await page.goto(link);
  await page.getByText(`You are signed in as ${people.ada.email}. Sign in as ${people.dee.email} to accept.`).waitFor();
  await page.getByRole('button', { name: 'Sign out and switch account' }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(origin + '/login');
  await usePassword(page);
  await page.getByLabel('Email').fill(people.dee.email);
  await page.getByRole('textbox', { name: /^Password/ }).fill(people.dee.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(origin + '/invite');
  // The address is not verified yet. A code sent to it verifies the address and accepts in one step.
  const sent = Date.now();
  await page.getByRole('button', { name: 'Send verification code' }).click();
  await page.getByLabel('Verification code').waitFor();
  await page.screenshot({ path: join(shots, 'invite-unverified.png'), fullPage: true });
  await enter(page.getByLabel('Verification code'), await codeIn(people.dee.email, sent));
  await page.getByRole('button', { name: 'Verify and join' }).click({ timeout: 2_000 }).catch(() => undefined);
  await page.waitForURL(/\/workspace\/teams\/[\w-]+$/);
  await expect(page.locator('[data-team-name]')).toHaveText('Operations');
  // An admin invites and manages roles below owner: its own role is offered, the owner's is not.
  await page.getByRole('button', { name: 'Invite', exact: true }).waitFor();
  await expect(page.getByRole('button', { name: new RegExp(`Role of ${people.dee.email}`) })).toHaveCount(1);
  await expect(page.getByRole('button', { name: new RegExp(`Role of ${people.owner.email}`) })).toHaveCount(0);
  await page.getByRole('button', { name: new RegExp(`Role of ${people.dee.email}`) }).click();
  await expect(page.getByRole('option')).toHaveText(['Admin', 'Member']);
  await page.keyboard.press('Escape');
  await page.context().close();
});

await journey('addresses from before the pages were merged still land in the right place', async () => {
  const team = operations.split('/').pop();
  for (const [from, to] of [['/workspace/applications', '/workspace'], ['/workspace/sessions', '/workspace/account#sessions'],
    ['/workspace/security', '/workspace/account#security'], ['/workspace/settings', '/workspace/account'],
    ['/zh/workspace/settings/account', '/zh/workspace/account#delete'], [`/workspace/teams?team=${team}`, operations]]) {
    await owner.goto(origin + from);
    await owner.waitForURL(origin + to);
  }
  // The rewrite replaces the old address, so Back does not return to it.
  await owner.goto(origin + '/workspace/tokens');
  await owner.goto(origin + '/workspace/security');
  await owner.waitForURL(origin + '/workspace/account#security');
  await owner.goBack();
  await owner.waitForURL(origin + '/workspace/tokens');
});

await journey('a team runs itself: applications, team tokens, audit, second factor, ownership', async () => {
  await owner.goto(origin + operations);
  const navigation = owner.getByRole('navigation', { name: 'Account navigation' });
  const group = navigation.getByRole('button', { name: 'Operations' });
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await navigation.getByRole('link', { name: 'Applications' }).nth(1).click();
  await owner.waitForURL(origin + operations + '/applications');
  await owner.getByRole('heading', { level: 1, name: 'Applications' }).waitFor();
  await expect(owner).toHaveTitle('Applications · Account center · Niltavi Identity');
  await owner.getByText('0 of 10').waitFor();
  await owner.getByLabel('Application ID').fill(`ops-${run}`);
  await owner.getByLabel('Name').fill('Ops Board');
  await owner.getByLabel('Address (https://…)').fill(`https://ops-${run}.localhost:${base + 3}/`);
  await owner.getByRole('button', { name: 'Register application' }).click();
  await owner.getByText('Application registered').waitFor();
  assert.match(await owner.locator('[data-secret="client-secret"]').innerText(), /^[\w-]{43}$/);
  await owner.getByRole('button', { name: 'Done' }).click();
  await owner.getByText('1 of 10').waitFor();
  await owner.screenshot({ path: join(shots, 'team-applications.png'), fullPage: true });
  // The console lists it with the team it belongs to, and the public application list leaves it out.
  assert.ok(!(await (await owner.request.get(origin + '/account/config')).json()).applications.some(({ id }) => id === `ops-${run}`));
  await owner.goto(origin + '/admin/applications');
  await owner.locator(`[data-application="ops-${run}"]`).getByText('Team · Operations').waitFor();
  await owner.getByText('Applications added by teams').waitFor();
  await owner.screenshot({ path: join(shots, 'admin-team-applications.png'), fullPage: true });

  // Members of the team find it on their first screen. Nobody else does.
  await owner.goto(origin + '/workspace');
  await owner.locator(`[data-apps="available"] [data-application="ops-${run}"]`).getByText('Operations').waitFor();
  const outsider = await session();
  await signInWithCode(outsider, people.ben);
  await expect(outsider.locator(`[data-application="ops-${run}"]`)).toHaveCount(0);
  // An account that signs in by code has no password to change, and is told so.
  // Sent to the team's application anyway, an outsider stops at Identity with the reason.
  const opsCallback = `https://ops-${run}.localhost:${base + 3}/auth/callback`;
  assert.equal((await outsider.goto(authorizationRequest(`ops-${run}`, opsCallback))).status(), 403);
  await outsider.getByRole('heading', { level: 1, name: 'Ops Board is for members of its team' }).waitFor();
  await outsider.getByText('Ask an administrator of Operations to invite you.').waitFor();
  await outsider.screenshot({ path: join(shots, 'protocol-denied.png'), fullPage: true });
  await outsider.getByRole('link', { name: 'See your applications' }).click();
  await outsider.waitForURL(origin + '/workspace');
  await outsider.goto(origin + '/workspace/account');
  await outsider.getByText('This account has no password.').waitFor();
  await expect(outsider.getByRole('button', { name: 'Change password' })).toHaveCount(0);
  await outsider.context().close();

  await owner.goto(origin + operations + '/tokens');
  await owner.getByText('No team tokens yet.').waitFor();
  await owner.getByLabel('Name').fill('deploy bot');
  await choose(owner, /Acts as/, 'Admin');
  await owner.getByRole('button', { name: 'Create token' }).click();
  assert.match(await owner.locator('[data-secret="agent-token"]').innerText(), /^nvt_[\w-]{43}$/);
  await owner.locator('[data-token="deploy bot"]').getByText('Admin').waitFor();
  await owner.getByRole('button', { name: 'Done' }).click();
  await owner.screenshot({ path: join(shots, 'team-tokens.png'), fullPage: true });

  await owner.goto(origin + operations + '/audit');
  const log = owner.getByRole('grid', { name: 'Audit log' });
  for (const event of ['Team created', 'Member invited', 'Application registered', 'Agent token created']) await log.getByText(event).first().waitFor();
  await expect(log.getByText('Signed in')).toHaveCount(0);

  await owner.goto(origin + operations + '/settings');
  await owner.getByRole('heading', { level: 1, name: 'Settings' }).waitFor();
  const rule = owner.getByRole('switch', { name: 'Require two-step verification' });
  await expect(rule).not.toBeChecked();
  await owner.getByText('Require two-step verification', { exact: true }).click();
  await expect(rule).toBeChecked();
  await owner.screenshot({ path: join(shots, 'team-settings.png'), fullPage: true });
  // An admin without a second factor can still see the team, and is told what managing it needs.
  const admin = await session();
  await signIn(admin, people.dee);
  await admin.goto(origin + operations);
  await admin.locator(`[data-member="${people.dee.email}"]`).waitFor();
  await admin.goto(origin + operations + '/audit');
  await admin.getByText('Making changes needs two-step verification on your account.').waitFor();
  await expect(admin.getByRole('grid', { name: 'Audit log' })).toHaveCount(0);
  // The team's application now waits for the second factor. Without one, the page says where to turn it on.
  const opsRequest = authorizationRequest(`ops-${run}`, `https://ops-${run}.localhost:${base + 3}/auth/callback`);
  await admin.goto(opsRequest);
  await admin.getByRole('heading', { level: 1, name: 'Two-step verification' }).waitFor();
  await admin.getByText('Operations asks for two-step verification before Ops Board opens.').waitFor();
  await expect(admin.getByRole('link', { name: 'Turn on two-step verification' })).toHaveAttribute('href', '/workspace/account#security');
  // With one, a code on that page sends the browser on to the application.
  const member = await session();
  await signIn(member, people.owner);
  await member.goto(opsRequest);
  await member.getByLabel('Code from your authenticator app').waitFor();
  await member.screenshot({ path: join(shots, 'protocol-second-factor.png'), fullPage: true });
  const returned = member.waitForRequest((request) => request.url().startsWith(`https://ops-${run}.localhost:${base + 3}/auth/callback?code=`));
  await enter(member.getByLabel('Code from your authenticator app'), await authenticatorCode());
  await returned;
  await member.context().close();
  await owner.getByText('Require two-step verification', { exact: true }).click();
  await expect(rule).not.toBeChecked();
  await admin.goto(origin + operations + '/audit');
  await admin.getByRole('grid', { name: 'Audit log' }).waitFor();
  await admin.context().close();

  // Deleting asks for the team's name, and takes the team out of the navigation.
  await owner.goto(origin + '/workspace/teams');
  await owner.getByLabel('Team name').fill('Short-lived');
  await owner.getByRole('button', { name: 'Create team' }).click();
  await expect(owner.locator('[data-team-name]')).toHaveText('Short-lived');
  await navigation.getByRole('button', { name: 'Short-lived' }).waitFor();
  await owner.goto(owner.url() + '/settings');
  await owner.getByText('Invite someone first.').waitFor();
  await owner.getByLabel('Type “Short-lived” to confirm').fill('short-lived');
  await owner.getByRole('button', { name: 'Delete team' }).click();
  await owner.getByText('The name does not match this team.').waitFor();
  await owner.getByLabel('Type “Short-lived” to confirm').fill('Short-lived');
  await owner.getByRole('button', { name: 'Delete team' }).click();
  await owner.waitForURL(origin + '/workspace/teams');
  await expect(navigation.getByRole('button', { name: 'Short-lived' })).toHaveCount(0);
});

await journey('account page: change the password, then the address', async () => {
  const page = await session();
  await signIn(page, people.dee);
  await page.goto(origin + '/workspace/account');
  await page.getByRole('button', { name: 'Change password' }).click();
  const next = password();
  await page.getByLabel('Current password').fill('not-the-password');
  await page.getByLabel('New password').fill(next);
  await page.getByRole('button', { name: 'Change password' }).click();
  await page.getByText('Your current password is incorrect.').waitFor();
  await page.getByLabel('Current password').fill(people.dee.password);
  await page.getByRole('button', { name: 'Change password' }).click();
  await page.getByText('Password changed. Your other devices were signed out.').waitFor();
  people.dee.password = next;
  await page.getByRole('heading', { level: 1, name: 'Account' }).waitFor();

  const moved = `dee-moved-${run}@example.test`;
  await page.getByRole('button', { name: 'Change email' }).click();
  await page.getByLabel('New email address').fill(moved);
  await page.getByLabel('Current password').fill(people.dee.password);
  const sent = Date.now();
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByText(`Enter the code we sent to ${moved}.`).waitFor();
  await enter(page.getByLabel('Verification code'), await codeIn(moved, sent));
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByText(`Your email address is now ${moved}.`).waitFor();
  await page.getByRole('button', { name: 'Account menu' }).getByText(moved).waitFor();
  await mail(people.dee.email, /now signs in with/, sent);
  people.dee.email = moved;
  await page.context().close();
  const again = await session();
  await signIn(again, people.dee);
  await again.context().close();
});

await journey('no horizontal overflow at 320px and desktop, light and dark, both languages', async () => {
  const signedOut = ['/', '/login', '/register', '/recover', '/reset', '/verify-email', '/invite', '/setup'];
  const signedIn = ['/workspace', '/workspace/account', '/workspace/teams', '/workspace/tokens',
    ...['', '/applications', '/tokens', '/audit', '/settings'].map((page) => operations + page),
    '/admin', '/admin/accounts', '/admin/teams', '/admin/applications', '/admin/mail', '/admin/audit'];
  const cookies = await owner.context().cookies();
  for (const colorScheme of ['light', 'dark']) {
    for (const width of [320, 1280]) {
      const guest = await session({ viewport: { width, height: 800 }, colorScheme });
      const member = await session({ viewport: { width, height: 800 }, colorScheme });
      await member.context().addCookies(cookies);
      for (const prefix of ['', '/zh']) {
        for (const [page, paths] of [[guest, signedOut], [member, signedIn]]) {
          for (const path of paths) {
            await page.goto(origin + prefix + path);
            await page.locator('main').waitFor();
            await page.waitForLoadState('networkidle');
            await page.waitForFunction(() => !document.querySelector('main [aria-busy="true"]'));
            const label = `${prefix}${path} ${width}px ${colorScheme}`;
            assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), colorScheme, `${label}: theme`);
            await noOverflow(page, label);
            await page.screenshot({ path: join(shots, `sweep-${colorScheme}-${width}-${(prefix + path).replace(/\W+/g, '_') || 'home'}.png`), fullPage: true });
          }
        }
      }
      await guest.context().close();
      await member.context().close();
    }
  }
});

await journey('shared account menus work across widths, themes, and languages', async () => {
  await owner.goto(origin + '/admin/accounts');
  const ada = owner.locator(`[data-account="${people.ada.email}"]`);
  await owner.getByLabel('Search by email or name').fill(people.ada.email);
  await owner.getByRole('button', { name: 'Search' }).click();
  await ada.getByRole('button', { name: `Manage ${people.ada.email}` }).click();
  await owner.getByRole('menuitem', { name: 'Make administrator' }).click();
  await ada.getByText('Administrator', { exact: true }).waitFor();

  for (const colorScheme of ['light', 'dark']) {
    for (const width of [320, 1280]) {
      const page = await session({ viewport: { width, height: 800 }, colorScheme });
      await signIn(page, people.ada);
      for (const zh of [false, true]) {
        const prefix = zh ? '/zh' : '';
        const label = zh ? '账号菜单' : 'Account menu';
        const signOut = zh ? '退出登录' : 'Sign out';
        const accountNavigation = zh ? '打开账号中心导航' : 'Open account navigation';
        const consoleNavigation = zh ? '打开实例管理台导航' : 'Open instance console navigation';
        await page.goto(origin + prefix + '/workspace');
        for (const [section, nav, target, action] of [
          ['workspace', accountNavigation, 'admin', zh ? '实例管理台' : 'Instance console'],
          ['admin', consoleNavigation, 'workspace', zh ? '账号中心' : 'Account center'],
        ]) {
          if (width === 320) await page.getByRole('button', { name: nav }).press('Enter');
          const trigger = page.getByRole('button', { name: label });
          await expect(trigger).toContainText('Ada L.');
          await expect(trigger).toContainText(people.ada.email);
          await trigger.press('Enter');
          const menu = page.getByRole('menu', { name: label });
          const link = menu.getByRole('menuitem', { name: action });
          await expect(link).toBeInViewport();
          await expect(link).toHaveAttribute('href', prefix + '/' + target);
          await expect(menu.getByRole('menuitem', { name: signOut })).toBeInViewport();
          await noOverflow(page, `${prefix}/${section} menu at ${width}px, ${colorScheme}`);
          await page.screenshot({ path: join(shots, `Z-261-${section}-${zh ? 'zh' : 'en'}-${width}-${colorScheme}.png`), animations: 'disabled' });
          await page.keyboard.press('Escape');
          await expect(menu).toBeHidden();
          await expect(trigger).toBeFocused();
          await trigger.press('ArrowDown');
          await expect(link).toBeFocused();
          await page.keyboard.press('Enter');
          await page.waitForURL(origin + prefix + '/' + target);
        }
        assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation')[0].name), origin + prefix + '/workspace');
        assert.equal(await page.locator('html').getAttribute('data-theme'), colorScheme);
      }
      await page.goto(origin + '/zh/admin');
      if (width === 320) await page.getByRole('button', { name: '打开实例管理台导航' }).press('Enter');
      await page.getByRole('button', { name: '账号菜单' }).press('Enter');
      await page.getByRole('menuitem', { name: '退出登录' }).press('Enter');
      await page.waitForURL(origin + '/zh/login');
      await page.goto(origin + '/zh/admin');
      await page.waitForURL(origin + '/zh/login');
      await page.context().close();
    }
  }
});

await journey('turning off two-step verification requires opening and confirming a dialog', async () => {
  await owner.goto(origin + '/workspace/security');
  const manage = owner.getByRole('button', { name: 'Manage two-step verification' });
  const dialog = owner.getByRole('dialog', { name: 'Turn off two-step verification?' });
  const code = owner.getByLabel('Current code from your authenticator app');
  const confirm = owner.getByRole('button', { name: 'Turn off two-step verification' });
  await expect(owner.getByText('On', { exact: true })).toBeVisible();
  await expect(confirm).toHaveCount(0);
  await expect(code).toHaveCount(0);

  await manage.press('Enter');
  await expect(dialog).toBeVisible();
  await enter(code, '000000');
  await confirm.click();
  await expect(dialog.getByText('The code is incorrect or has expired.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(manage).toBeFocused();
  await expect(owner.getByText('On', { exact: true })).toBeVisible();

  await manage.click();
  await expect(code).toHaveValue('');
  await expect(dialog.getByText('The code is incorrect or has expired.')).toHaveCount(0);
  await enter(code, await authenticatorCode());
  await confirm.click();
  await expect(dialog).toBeHidden();
  await expect(owner.getByText('Two-step verification is off.')).toBeVisible();
  await owner.reload();
  await expect(owner.getByText('Off', { exact: true })).toBeVisible();
  await expect(owner.getByRole('button', { name: 'Set up two-step verification' })).toBeVisible();
});

await journey('no script errors on any page', async () => assert.deepEqual(pageErrors, []));
await browser.close();
const failed = results.filter(({ ok }) => !ok);
console.log(`\n${results.length - failed.length} of ${results.length} journeys passed. Screenshots: ${shots}`);
process.exit(failed.length ? 1 : 0);
