/**
 * Reiht einen Job manuell ein (z. B. zum Testen), ohne auf den Zeitplan zu warten.
 *   npm run job -- ingest-arxiv-daily
 *   npm run job -- backfill 42
 * Die Verarbeitung übernimmt der laufende Worker.
 */
import { createDatabase, requireDatabaseUrl } from '../src/lib/server/db/index';
import { createBoss, QUEUES, requestBackfill, setupQueues } from '../src/lib/server/jobs/queues';

const [name, arg] = process.argv.slice(2);
const names = Object.values(QUEUES) as string[];
if (!name || !names.includes(name)) {
	console.error(`Aufruf: npm run job -- <${names.join('|')}> [sourceQueryId]`);
	process.exit(2);
}

const url = requireDatabaseUrl();
const boss = createBoss(url, 'app');
const database = createDatabase(url, 1);
await boss.start();
await setupQueues(boss);
if (name === QUEUES.backfill) {
	const id = Number(arg);
	if (!Number.isInteger(id)) {
		console.error('backfill braucht eine sourceQueryId');
		process.exitCode = 2;
	} else {
		await requestBackfill(boss, database.db, id);
		console.log(`Backfill für source_query ${id} eingereiht`);
	}
} else {
	const id = await boss.send(name, null);
	console.log(id ? `Job ${id} eingereiht (${name})` : `${name}: bereits ein Job wartend`);
}
await boss.stop({ graceful: false });
await database.close();
