import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { accountId, loginCookie } from './fixtures.js';
import { startLab } from './harness.js';

type Lab = Awaited<ReturnType<typeof startLab>>;
type RP = Lab['a'];

let lab: Lab | undefined;
test.beforeEach(async () => { lab = await startLab(); });
test.afterEach(async () => {
  const completed = lab;
  lab = undefined;
  await completed?.close();
});

function activeLab() {
  if (!lab) throw new Error('The lab failed to start.');
  return lab;
}

async function signIn(page: Page, rp: RP, expectInteraction: boolean) {
  await page.goto(rp.spec.origin);
  await page.getByRole('link', { name: 'Sign in' }).click();
  if (expectInteraction) {
    await page.getByRole('button', { name: 'Sign in as fixture user' }).click();
  }
  await expect(page.getByText('Signed in', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(`${rp.spec.origin}/`);
}

function profile(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/me');
    return { status: response.status, body: await response.json() };
  });
}

async function session(page: Page, rp: RP) {
  const key = (await page.context().cookies(rp.spec.origin)).find((item) => item.name === loginCookie);
  const found = key && rp.session(key.value);
  if (!found) throw new Error('Expected the RP to hold a server-side session.');
  return found;
}

async function signOutAll(page: Page) {
  await page.getByRole('button', { name: 'Sign out of all apps' }).click();
  await page.getByRole('button', { name: 'End session' }).click();
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
}

async function issueCode(page: Page, rp: RP) {
  const flow = await rp.authorize();
  rp.holdCallback(flow.state);
  await page.goto(flow.url.href);
  await expect(page.getByText('Code received by the protocol fixture.')).toBeVisible();
  const redirect = rp.takeCallback(flow.state);
  if (!redirect?.searchParams.has('code')) throw new Error('Expected an authorization code.');
  return { flow, redirect };
}

test('two sites reuse the center session and receive signed back-channel logout', async ({ page, context }) => {
  const { a, b, identity, issuer } = activeLab();
  await signIn(page, a, true);
  const other = await context.newPage();
  await signIn(other, b, false);
  expect(identity.interactionCount).toBe(1);
  expect(b.callbackSite).toBe('cross-site');
  expect(await profile(page)).toEqual({ status: 200, body: { iss: issuer, sub: accountId } });
  expect(await profile(other)).toEqual({ status: 200, body: { iss: issuer, sub: accountId } });

  await page.getByRole('button', { name: 'Sign out of this app' }).click();
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  expect((await profile(page)).status).toBe(401);
  expect((await profile(other)).status).toBe(200);
  await signIn(page, a, false);
  const before = performance.now();
  await signOutAll(page);
  await expect.poll(() => [a.logoutCount, b.logoutCount], { timeout: 5_000 }).toEqual([1, 1]);
  expect(performance.now() - before).toBeLessThan(5_000);
  expect(identity.successfulLogouts).toBe(2);
  expect((await profile(page)).status).toBe(401);
  await other.reload();
  await expect(other.getByRole('link', { name: 'Sign in' })).toBeVisible();
  expect((await profile(other)).status).toBe(401);
});

test('online introspection denies access even when the logout notification cannot be delivered', async ({ page, context }) => {
  const { a, b, identity } = activeLab();
  await signIn(page, a, true);
  const other = await context.newPage();
  await signIn(other, b, false);
  const oldSession = await session(other, b);
  b.setLogoutReceiverAvailable(false);
  const before = performance.now();
  await signOutAll(page);
  expect(identity.successfulLogouts).toBe(1);
  expect(b.logoutCount).toBe(0);
  expect((await b.introspect(oldSession.accessToken)).active).toBe(false);
  expect((await profile(other)).status).toBe(401);
  expect(performance.now() - before).toBeLessThan(30_000);
});

test('PKCE is required and only one concurrent code exchange succeeds', async ({ page, context }) => {
  const { a } = activeLab();
  await signIn(page, a, true);
  const negative = await context.newPage();
  const missingPkce = (await a.authorize()).url;
  missingPkce.searchParams.delete('code_challenge');
  missingPkce.searchParams.delete('code_challenge_method');
  await negative.goto(missingPkce.href);
  expect(new URL(negative.url()).searchParams.get('error')).toBe('invalid_request');

  const codePage = await context.newPage();
  const { flow, redirect } = await issueCode(codePage, a);
  const results = await Promise.allSettled([a.exchange(redirect, flow), a.exchange(redirect, flow)]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find((result) => result.status === 'rejected');
  expect(rejected?.reason).toMatchObject({ error: 'invalid_grant' });
});

test('disabling an account rejects old sessions, code exchanges, and refreshes', async ({ page, context }) => {
  const { a, b, disable } = activeLab();
  await signIn(page, a, true);
  const other = await context.newPage();
  await signIn(other, b, false);
  const first = await session(page, a);
  const second = await session(other, b);
  expect((await a.introspect(first.accessToken)).active).toBe(true);
  expect((await b.introspect(second.accessToken)).active).toBe(true);
  const pending = await issueCode(await context.newPage(), b);
  // Exercise the bound on an exchange that started before the disable commit.
  const [refreshing, disabled] = await Promise.allSettled([a.refresh(first.refreshToken), disable()]);
  expect(disabled).toMatchObject({ status: 'fulfilled', value: true });
  // The parallel refresh either failed at the grant boundary or returned an inactive token.
  if (refreshing?.status === 'fulfilled') {
    expect((await a.introspect(refreshing.value.access_token)).active).toBe(false);
  } else {
    expect(refreshing?.reason).toMatchObject({ error: 'invalid_grant' });
  }
  expect(await disable()).toBe(false);

  const before = performance.now();
  expect((await a.introspect(first.accessToken)).active).toBe(false);
  expect((await b.introspect(second.accessToken)).active).toBe(false);
  await expect(b.refresh(second.refreshToken)).rejects.toMatchObject({ error: 'invalid_grant' });
  await expect(b.exchange(pending.redirect, pending.flow)).rejects.toMatchObject({ error: 'invalid_grant' });
  expect((await profile(page)).status).toBe(401);
  expect((await profile(other)).status).toBe(401);
  expect(performance.now() - before).toBeLessThan(30_000);
  await page.goto(`${a.spec.origin}/login`);
  await expect(page.getByRole('heading', { name: 'Account disabled' })).toBeVisible();
});
