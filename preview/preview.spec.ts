import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function reset(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(page.getByText('Sign in to App A, then open App B.')).toBeVisible();
}

async function signInBoth(page: Page) {
  await page.getByRole('button', { name: 'Sign in to App A' }).click();
  const a = page.getByRole('article', { name: 'App A' });
  const b = page.getByRole('article', { name: 'App B' });
  await expect(a.getByText('HTTP 200', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open App B' }).click();
  await expect(page.getByText('App B granted access without another sign-in prompt.')).toBeVisible();
  await expect(b.getByText('HTTP 200', { exact: true })).toBeVisible();
  await expect(a.getByText('lab-user', { exact: true })).toBeVisible();
  await expect(b.getByText('lab-user', { exact: true })).toBeVisible();
}

test('the acceptance page shows real SSO and both signed logout receipts', async ({ page }) => {
  await reset(page);
  await expect(page.getByRole('button', { name: 'Sign out of all apps' })).toBeDisabled();
  await signInBoth(page);
  await expect(page.getByText('Central sign-in prompts')).toHaveText('Central sign-in prompts 1');
  await page.getByRole('button', { name: 'Sign out of all apps' }).click();
  await expect(page.getByText('Both applications received the signed logout notification and denied access.')).toBeVisible();
  await expect(page.getByText('HTTP 401', { exact: true })).toHaveCount(2);
  for (const name of ['App A', 'App B']) {
    await expect(page.getByRole('article', { name }).getByText('1', { exact: true })).toBeVisible();
  }
  await reset(page);
});

test('the page verifies the 401 when App B misses the back-channel logout notification', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await reset(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Open App B' }).click();
  await expect(page.getByText('App B reached the sign-in prompt.')).toBeVisible();
  await signInBoth(page);
  const receiver = 'Make App B’s logout receiver unavailable';
  await page.getByText(receiver, { exact: true }).click();
  await expect(page.getByRole('checkbox', { name: receiver })).toBeChecked();
  await page.getByRole('button', { name: 'Sign out of all apps' }).click();
  await expect(page.getByText('App B missed the logout notification. Its next access check still returned HTTP 401.')).toBeVisible();
  const b = page.getByRole('article', { name: 'App B' });
  await expect(b.getByText('HTTP 401', { exact: true })).toBeVisible();
  await expect(b.getByText('0', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await reset(page);
});
