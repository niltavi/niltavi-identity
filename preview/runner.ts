import { chromium } from '@playwright/test';
import type { Page } from '@playwright/test';
import { browserArgs } from '../lab/browser-options.js';
import { startLab } from '../lab/harness.js';
import { initialState } from './contract.js';
import type { AppEvidence, Command, PreviewState } from './contract.js';

async function startFixture() {
  const lab = await startLab(43140);
  try {
    const browser = await chromium.launch({ args: browserArgs });
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const [a, b] = await Promise.all([context.newPage(), context.newPage()]);
      return { lab, a, b, close: async () => {
        await browser.close().finally(() => lab.close());
      } };
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    await lab.close().catch(() => undefined);
    throw error;
  }
}

async function observe(page: Page, origin: string, logoutReceipts: number): Promise<AppEvidence> {
  const response = await page.goto(`${origin}/api/me`);
  if (!response) throw new Error('The relying party did not respond.');
  const body: unknown = await response.json();
  const sub = typeof body === 'object' && body !== null && 'sub' in body && typeof body.sub === 'string'
    ? body.sub : null;
  return { httpStatus: response.status(), sub, logoutReceipts };
}

async function beginLogin(page: Page, origin: string) {
  await page.goto(origin);
  const signedIn = page.getByText('Signed in', { exact: true });
  if (await signedIn.isVisible()) return false;
  await page.getByRole('link', { name: 'Sign in' }).click();
  const login = page.getByRole('button', { name: 'Sign in as fixture user' });
  await signedIn.or(login).waitFor({ timeout: 8_000 });
  return login.isVisible();
}

export function createRunner() {
  let fixture: Awaited<ReturnType<typeof startFixture>> | undefined;
  let state = initialState();

  async function close() {
    const previous = fixture;
    fixture = undefined;
    await previous?.close();
  }

  async function execute(command: Command): Promise<PreviewState> {
    if (command.action === 'reset') {
      await close();
      state = initialState();
      return state;
    }

    fixture ??= await startFixture();
    const { lab, a, b } = fixture;
    switch (command.action) {
      case 'sign-in-a': {
        if (await beginLogin(a, lab.a.spec.origin)) {
          await a.getByRole('button', { name: 'Sign in as fixture user' }).click();
          await a.getByText('Signed in', { exact: true }).waitFor({ timeout: 8_000 });
        }
        const aEvidence = await observe(a, lab.a.spec.origin, lab.a.logoutCount);
        if (aEvidence.httpStatus !== 200) throw new Error('App A did not grant access.');
        state = { ...state, a: aEvidence, loginPrompts: lab.identity.interactionCount, outcome: 'a-signed-in' };
        break;
      }
      case 'open-b': {
        const prompted = await beginLogin(b, lab.b.spec.origin);
        const bEvidence = await observe(b, lab.b.spec.origin, lab.b.logoutCount);
        if (bEvidence.httpStatus !== (prompted ? 401 : 200)) {
          throw new Error('App B returned an unexpected authorization result.');
        }
        state = {
          ...state, b: bEvidence, loginPrompts: lab.identity.interactionCount,
          outcome: prompted ? 'b-needs-login' : 'b-reused-session',
        };
        break;
      }
      case 'logout': {
        if (state.a.httpStatus !== 200 || state.b.httpStatus !== 200) {
          throw new Error('Both applications must be signed in before the logout comparison.');
        }
        lab.b.setLogoutReceiverAvailable(!command.simulateUnavailableB);
        const priorDeliveries = lab.b.logoutCount;
        await a.goto(lab.a.spec.origin);
        await a.getByRole('button', { name: 'Sign out of all apps' }).click();
        await a.getByRole('button', { name: 'End session' }).click();
        await a.getByRole('link', { name: 'Sign in' }).waitFor({ timeout: 8_000 });
        const [aEvidence, bEvidence] = await Promise.all([
          observe(a, lab.a.spec.origin, lab.a.logoutCount),
          observe(b, lab.b.spec.origin, lab.b.logoutCount),
        ]);
        if (aEvidence.httpStatus !== 401 || bEvidence.httpStatus !== 401) {
          throw new Error('An application retained access after global logout.');
        }
        state = {
          a: aEvidence, b: bEvidence, loginPrompts: lab.identity.interactionCount,
          outcome: bEvidence.logoutReceipts === priorDeliveries ? 'logout-receiver-unavailable' : 'logged-out',
        };
        break;
      }
    }
    return state;
  }

  return { execute, read: () => state, close };
}
