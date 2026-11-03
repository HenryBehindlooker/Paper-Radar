import { sveltekit } from '@sveltejs/kit/vite';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
	// Nur die Testdatenbank aus `.env` übernehmen (Prozess-Umgebung hat Vorrang).
	const fileEnv = loadEnv(mode, process.cwd(), 'TEST_DATABASE_URL');
	const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? fileEnv.TEST_DATABASE_URL;

	return {
		plugins: [sveltekit()],
		test: {
			environment: 'node',
			env: testDatabaseUrl ? { TEST_DATABASE_URL: testDatabaseUrl } : {},
			projects: [
				{
					extends: true,
					test: {
						name: 'unit',
						include: ['src/**/*.{test,spec}.ts', 'tests/unit/**/*.{test,spec}.ts']
					}
				},
				{
					// Gegen eine echte PostgreSQL (TEST_DATABASE_URL); Dateien laufen nacheinander,
					// da sie sich eine Datenbank teilen.
					extends: true,
					test: {
						name: 'integration',
						include: ['tests/integration/**/*.test.ts'],
						fileParallelism: false,
						testTimeout: 30_000,
						hookTimeout: 30_000
					}
				}
			]
		}
	};
});
