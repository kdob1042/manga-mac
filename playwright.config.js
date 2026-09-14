import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests/ui', use: { baseURL: 'http://127.0.0.1:5173', viewport: { width: 1360, height: 920 } }, webServer: { command: 'npm run dev', url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI } });
