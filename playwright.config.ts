import { defineConfig } from '@playwright/test';

/**
 * E2E-Tests brauchen PostgreSQL und Mailpit (siehe docker-compose.dev.yml).
 * Die App läuft dafür gegen eine eigene Datenbank.
 */
export const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? 'http://127.0.0.1:8025';
export const E2E_DATABASE_URL =
	process.env.E2E_DATABASE_URL ?? 'postgres://paperradar:paperradar@localhost:5432/paperradar_e2e';
export const E2E_AUTH_SECRET =
	process.env.E2E_AUTH_SECRET ?? 'e2e-only-secret-never-use-in-production-0123456789';
export const E2E_ORIGIN = 'http://localhost:4173';
const PORT = 4173;

const appEnv = {
	DATABASE_URL: E2E_DATABASE_URL,
	ORIGIN: `http://localhost:${PORT}`,
	AUTH_SECRET: E2E_AUTH_SECRET,
	AUTH_TRUST_HOST: 'true',
	SMTP_HOST: process.env.E2E_SMTP_HOST ?? '127.0.0.1',
	SMTP_PORT: process.env.E2E_SMTP_PORT ?? '1025',
	SMTP_SECURE: 'false',
	SMTP_USER: '',
	SMTP_PASSWORD: '',
	MAIL_FROM: 'Paper-Radar <noreply@example.org>'
};

export default defineConfig({
	testDir: 'tests/e2e',
	fullyParallel: false,
	workers: 1,
	webServer: {
		command: `npm run db:migrate && npm run build && npm run preview -- --port ${PORT} --strictPort`,
		port: PORT,
		reuseExistingServer: !process.env.CI,
		timeout: 180_000,
		env: { ...(process.env as Record<string, string>), ...appEnv }
	},
	use: {
		baseURL: `http://localhost:${PORT}`
	}
});
