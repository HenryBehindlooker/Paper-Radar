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
import { loadRankingConfig } from './lib/server/ranking/score';
import { createTransport, loadSmtpConfig } from './lib/server/mail';
import { deriveKey } from './lib/server/tokens';
import { loadOpenAlexBudget, OpenAlexUsageTracker } from './lib/server/enrichment/budget';
import { createSources } from './lib/server/sources/index';

const log = createLogger('worker');

/** Versandkonfiguration der Wochen-Mail aus der Umgebung (fehlt etwas → kein Versand). */
function digestConfig(): Pick<JobContext, 'digest'> {
	const origin = process.env.ORIGIN?.trim();
	const secret = process.env.AUTH_SECRET?.trim();
	if (!origin || !secret) {
		log.warn('Wochen-Mail deaktiviert: ORIGIN und AUTH_SECRET müssen gesetzt sein');
		return {};
	}
	const smtp = loadSmtpConfig(process.env);
	const transport = createTransport(smtp);
	return {
		digest: {
			origin,
			key: deriveKey(secret, 'digest-unsubscribe'),
			send: async (mail) => {
				await transport.sendMail({
					from: smtp.from,
					to: mail.to,
					subject: mail.subject,
					text: mail.text,
					html: mail.html,
					headers: mail.headers
				});
			}
		}
	};
}

async function main(): Promise<void> {
	const url = requireDatabaseUrl();
	const database = createDatabase(url, 5);
	await runMigrations(database.db);
	log.info('Datenbank-Migrationen geprüft');

	const tracker = new OpenAlexUsageTracker();
	const sources = createSources(loadSourcesConfig(), {
		logger: log.child('sources'),
		// Credit-Verbrauch jedes OpenAlex-Requests protokollieren (Header X-RateLimit-*).
		onOpenAlexUsage: (usage) => tracker.record(usage)
	});
	const ctx: JobContext = {
		db: database.db,
		sources,
		logger: log.child('jobs'),
		now: () => new Date(),
		ranking: loadRankingConfig(process.env),
		enrichment: { openalex: sources.openalex, tracker, budget: loadOpenAlexBudget(process.env) },
		...digestConfig()
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
