import { env } from '$env/dynamic/private';
import type { PgBoss } from 'pg-boss';
import { createDatabase, type Database } from './db/index';
import { createBoss, setupQueues } from './jobs/queues';
import { createLogger } from './log';
import { deriveKey } from './tokens';

/**
 * Prozessweite Dienste der Web-App. Die App spricht nie mit Upstream-APIs –
 * sie liest/schreibt die Datenbank und reiht höchstens Jobs ein.
 */

const log = createLogger('app');

let database: Database | undefined;
let bossPromise: Promise<PgBoss> | undefined;

export function databaseUrl(): string {
	const url = env.DATABASE_URL?.trim();
	if (!url) throw new Error('DATABASE_URL ist nicht gesetzt (siehe .env.example)');
	return url;
}

export function getDatabase(): Database {
	database ??= createDatabase(databaseUrl(), 10);
	return database;
}

export function getDb() {
	return getDatabase().db;
}

/** pg-boss nur zum Einreihen (keine Wartung, keine Zeitpläne). */
export function getBoss(): Promise<PgBoss> {
	bossPromise ??= (async () => {
		const boss = createBoss(databaseUrl(), 'app');
		boss.on('error', (error) => log.error('pg-boss', { error: String(error) }));
		await boss.start({ attempts: 3 });
		await setupQueues(boss);
		return boss;
	})().catch((error: unknown) => {
		bossPromise = undefined;
		throw error;
	});
	return bossPromise;
}

/** Öffentliche Basis-URL der Instanz (für Feed- und Abmelde-Links). */
export function appOrigin(fallback: string): string {
	return (env.ORIGIN?.trim() || fallback).replace(/\/$/, '');
}

let keys: { feed: Buffer; unsubscribe: Buffer } | undefined;

/** Aus AUTH_SECRET abgeleitete, zweckgebundene Schlüssel. */
export function appKeys(): { feed: Buffer; unsubscribe: Buffer } {
	keys ??= {
		feed: deriveKey(env.AUTH_SECRET ?? '', 'feed'),
		unsubscribe: deriveKey(env.AUTH_SECRET ?? '', 'digest-unsubscribe')
	};
	return keys;
}
