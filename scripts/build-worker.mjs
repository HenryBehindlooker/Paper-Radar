/**
 * Bündelt Worker und CLI-Skripte für die Produktion nach `dist/` (ohne tsx).
 * Laufzeit-Abhängigkeiten (node_modules) bleiben extern; die SQL-Migrationen liegen im
 * Image unter MIGRATIONS_FOLDER.
 */
import { build } from 'esbuild';

await build({
	entryPoints: {
		worker: 'src/worker.ts',
		migrate: 'scripts/migrate.ts',
		job: 'scripts/enqueue.ts'
	},
	outdir: 'dist',
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node22',
	packages: 'external',
	sourcemap: true,
	logLevel: 'info',
	banner: { js: '// Paper-Radar – erzeugt von scripts/build-worker.mjs' }
});
