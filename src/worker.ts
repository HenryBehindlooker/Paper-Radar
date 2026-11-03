/**
 * Worker-Prozess: führt Migrationen aus, richtet pg-boss-Queues und Zeitpläne ein
 * und verarbeitet alle Jobs. Nur dieser Prozess spricht mit den Upstream-APIs.
 *
 * Es darf genau EIN Worker laufen: die Rate-Limiter sind prozesslokal.
 *   npm run worker
 */
import { loadSourcesConfig } from './lib/server/config';
import { createDatabase, requireDatabaseUrl, runMigrations } from './lib/server/db/index';
import type { JobContext } from './lib/server/jobs/context';
import {
	createBoss,
	registerSchedules,
	registerWorkers,
	setupQueues
} from './lib/server/jobs/queues';
import { createLogger } from './lib/server/log';
import { createSources } from './lib/server/sources/index';

const log = createLogger('worker');

async function main(): Promise<void> {
	const url = requireDatabaseUrl();
	const database = createDatabase(url, 5);
	await runMigrations(database.db);
	log.info('Datenbank-Migrationen geprüft');

	const sources = createSources(loadSourcesConfig(), { logger: log.child('sources') });
	const ctx: JobContext = {
		db: database.db,
		sources,
		logger: log.child('jobs'),
		now: () => new Date()
	};

	const boss = createBoss(url, 'worker');
	boss.on('error', (error) => log.error('pg-boss', { error: String(error) }));
	await boss.start({ attempts: 5 });
	await setupQueues(boss);
	await registerSchedules(boss);
	await registerWorkers(boss, ctx);
	log.info('Worker bereit', { openalex: sources.openalex.enabled });

	let stopping = false;
	const shutdown = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		log.info('Beende Worker', { signal });
		await boss.stop({ graceful: true, timeout: 30_000 });
		await database.close();
		process.exit(0);
	};
	process.on('SIGTERM', () => void shutdown('SIGTERM'));
	process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
	log.error('Worker-Start fehlgeschlagen', {
		error: error instanceof Error ? (error.stack ?? error.message) : String(error)
	});
	process.exit(1);
});
