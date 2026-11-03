import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '$lib/server/sources/clock';
import type { FetchLike } from '$lib/server/sources/http';

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures');

export function fixture(path: string): string {
	return readFileSync(join(FIXTURES, path), 'utf8');
}

/** Virtuelle Uhr: `sleep` springt sofort vorwärts. */
export class FakeClock implements Clock {
	t = 0;
	now(): number {
		return this.t;
	}
	async sleep(ms: number): Promise<void> {
		this.t += Math.max(0, ms);
	}
}

export interface MockReply {
	status?: number;
	body?: string;
	headers?: Record<string, string>;
}

export interface RecordedCall {
	url: string;
	at: number;
	headers: Record<string, string>;
}

/** Fetch-Attrappe: zeichnet Aufrufe (mit virtueller Zeit) auf und antwortet per Funktion. */
export function mockFetch(
	reply: (url: string, callIndex: number) => MockReply,
	clock?: Clock
): FetchLike & { calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const fn = async (input: string, init?: RequestInit) => {
		const headers = Object.fromEntries(new Headers(init?.headers).entries());
		calls.push({ url: input, at: clock?.now() ?? 0, headers });
		const r = reply(input, calls.length - 1);
		return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers ?? {} });
	};
	return Object.assign(fn, { calls });
}
