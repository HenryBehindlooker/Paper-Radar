import { fileURLToPath } from 'node:url';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
/** Datenbank oder laufende Transaktion. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface Database {
	db: Db;
	pool: pg.Pool;
	close(): Promise<void>;
}

export function createDatabase(connectionString: string, max = 10): Database {
	const pool = new pg.Pool({ connectionString, max, application_name: 'paper-radar' });
	const db = drizzle(pool, { schema });
	return { db, pool, close: () => pool.end() };
}

/** Pfad der SQL-Migrationen (im Repo und im Docker-Image an derselben relativen Stelle). */
export const MIGRATIONS_FOLDER =
	process.env.MIGRATIONS_FOLDER ?? fileURLToPath(new URL('./migrations', import.meta.url));

export async function runMigrations(db: Db, migrationsFolder = MIGRATIONS_FOLDER): Promise<void> {
	await migrate(db, { migrationsFolder });
}

export function requireDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	const url = env.DATABASE_URL?.trim();
	if (!url) throw new Error('DATABASE_URL ist nicht gesetzt (siehe .env.example)');
	return url;
}

export { schema };
