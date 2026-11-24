import { defineConfig } from '@playwright/test';
import { browserArgs } from './lab/browser-options.js';

export default defineConfig({
  testDir: './lab',
  testMatch: '**/*.spec.ts',
  workers: 1,
  timeout: 40_000,
  use: {
    browserName: 'chromium',
    ignoreHTTPSErrors: true,
    launchOptions: { args: browserArgs },
  },
});
