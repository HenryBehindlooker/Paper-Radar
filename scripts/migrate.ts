/**
 * Wendet alle ausstehenden Datenbank-Migrationen an.
 *   npm run db:migrate
 */
import { createDatabase, requireDatabaseUrl, runMigrations } from '../src/lib/server/db/index';
import { createLogger } from '../src/lib/server/log';

const log = createLogger('migrate');
const database = createDatabase(requireDatabaseUrl(), 1);
try {
	await runMigrations(database.db);
	log.info('Migrationen angewendet');
} catch (error) {
	log.error('Migration fehlgeschlagen', { error: String(error) });
	process.exitCode = 1;
} finally {
	await database.close();
}
