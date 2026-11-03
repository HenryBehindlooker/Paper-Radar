import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Signierte, zustandslose Tokens für geheime URLs (Feed, Abmeldelink).
 * Schlüssel werden pro Zweck aus `AUTH_SECRET` abgeleitet; in der Datenbank steht
 * höchstens die öffentliche ID, nie die Signatur.
 */

export type TokenPurpose = 'feed' | 'digest-unsubscribe';

/** Zweckgebundener Schlüssel aus dem Server-Secret. */
export function deriveKey(secret: string, purpose: TokenPurpose): Buffer {
	if (!secret || secret.length < 16) {
		throw new Error('AUTH_SECRET fehlt oder ist zu kurz (mind. 16 Zeichen, empfohlen 32+)');
	}
	return createHmac('sha256', secret).update(`paper-radar:${purpose}`).digest();
}

function signature(key: Buffer, payload: string): string {
	return createHmac('sha256', key).update(payload).digest('base64url');
}

/** `payload.signatur` – Payload darf keinen Punkt enthalten. */
export function signToken(key: Buffer, payload: string): string {
	if (payload.includes('.')) throw new Error('Payload darf keinen Punkt enthalten');
	return `${payload}.${signature(key, payload)}`;
}

/** Liefert den Payload, wenn die Signatur stimmt, sonst `null` (zeitkonstanter Vergleich). */
export function verifyToken(key: Buffer, token: string): string | null {
	if (typeof token !== 'string' || token.length > 300) return null;
	const dot = token.lastIndexOf('.');
	if (dot <= 0) return null;
	const payload = token.slice(0, dot);
	const given = Buffer.from(token.slice(dot + 1), 'base64url');
	const expected = Buffer.from(signature(key, payload), 'base64url');
	if (given.length !== expected.length) return null;
	return timingSafeEqual(given, expected) ? payload : null;
}

/** Neue, zufällige öffentliche Feed-ID (128 Bit). */
export function newFeedId(): string {
	return randomBytes(16).toString('base64url');
}
