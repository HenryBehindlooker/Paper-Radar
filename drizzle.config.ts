import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	dialect: 'postgresql',
	schema: './src/lib/server/db/schema.ts',
	out: './src/lib/server/db/migrations',
	dbCredentials: {
		url: process.env.DATABASE_URL ?? 'postgres://paperradar:paperradar@localhost:5432/paperradar'
	},
	strict: true,
	verbose: true
});
