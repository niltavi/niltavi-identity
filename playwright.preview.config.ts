import { defineConfig } from '@playwright/test';

const url = `http://127.0.0.1:${process.env.IDENTITY_PREVIEW_PORT ?? '4187'}`;
export default defineConfig({
  testDir: './preview',
  testMatch: 'preview.spec.ts',
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: { baseURL: url, browserName: 'chromium' },
  webServer: {
    command: 'npm run preview:lab',
    url,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
