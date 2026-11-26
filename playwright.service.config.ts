import { defineConfig } from '@playwright/test';
import { browserArgs } from './lab/browser-options.js';

const strict = Boolean(process.env.IDENTITY_LOCAL_NSS_SEED);

export default defineConfig({
  testDir: './acceptance',
  testMatch: 'service.spec.ts',
  outputDir: './test-results/service',
  workers: 1,
  timeout: 150_000,
  expect: { timeout: 12_000 },
  use: { browserName: strict ? 'firefox' : 'chromium', headless: true, ignoreHTTPSErrors: !strict,
    launchOptions: strict ? {} : { args: browserArgs } },
});
