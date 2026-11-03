import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'tests/e2e',
	webServer: {
		command: 'npm run build && npm run preview -- --port 4173 --strictPort',
		port: 4173,
		reuseExistingServer: !process.env.CI
	},
	use: {
		baseURL: 'http://localhost:4173'
	}
});
