import { systemClock, type Clock } from './clock';

export interface RateLimiterOptions {
	name: string;
	/** Mindestabstand zwischen zwei Request-Starts in ms. */
	minIntervalMs: number;
	/** Maximale Zahl gleichzeitig laufender Requests. */
	maxConcurrent: number;
	/**
	 * Zusätzlich `minIntervalMs` nach dem Ende des vorherigen Requests warten
	 * (strenger; für arXiv: „1 Request alle 3 Sekunden, eine Verbindung“).
	 */
	spacingFromCompletion?: boolean;
	clock?: Clock;
	onEvent?: (event: RateLimiterEvent) => void;
}

export type RateLimiterEvent =
	| { type: 'acquire'; limiter: string; at: number; waitedMs: number; active: number }
	| { type: 'release'; limiter: string; at: number; active: number }
	| { type: 'pause'; limiter: string; at: number; until: number };

/**
 * FIFO-Limiter pro Quelle: begrenzt Rate (Mindestabstand) und Parallelität.
 * Alle Requests einer Quelle – auch Retries – laufen durch genau einen Limiter.
 */
export class RateLimiter {
	readonly name: string;
	#minIntervalMs: number;
	#maxConcurrent: number;
	readonly #spacingFromCompletion: boolean;
	readonly #clock: Clock;
	readonly #onEvent?: (event: RateLimiterEvent) => void;

	#gate: Promise<void> = Promise.resolve();
	#active = 0;
	#lastStart = Number.NEGATIVE_INFINITY;
	#lastEnd = Number.NEGATIVE_INFINITY;
	#pausedUntil = 0;
	#slotWaiters: Array<() => void> = [];

	constructor(options: RateLimiterOptions) {
		if (options.minIntervalMs < 0) throw new RangeError('minIntervalMs muss >= 0 sein');
		if (options.maxConcurrent < 1) throw new RangeError('maxConcurrent muss >= 1 sein');
		this.name = options.name;
		this.#minIntervalMs = options.minIntervalMs;
		this.#maxConcurrent = options.maxConcurrent;
		this.#spacingFromCompletion = options.spacingFromCompletion ?? false;
		this.#clock = options.clock ?? systemClock;
		this.#onEvent = options.onEvent;
	}

	get minIntervalMs(): number {
		return this.#minIntervalMs;
	}

	get maxConcurrent(): number {
		return this.#maxConcurrent;
	}

	get active(): number {
		return this.#active;
	}

	/** Führt `task` aus, sobald Rate- und Parallelitätslimit es erlauben. */
	async schedule<T>(task: () => Promise<T>): Promise<T> {
		await this.#acquire();
		try {
			return await task();
		} finally {
			this.#release();
		}
	}

	/** Hält alle weiteren Starts mindestens `ms` lang an (z. B. nach `Retry-After`). */
	pauseFor(ms: number): void {
		const until = this.#clock.now() + Math.max(0, ms);
		if (until > this.#pausedUntil) {
			this.#pausedUntil = until;
			this.#onEvent?.({ type: 'pause', limiter: this.name, at: this.#clock.now(), until });
		}
	}

	/**
	 * Passt die Limits an (z. B. an Crossrefs `x-rate-limit-*`-Header).
	 * Es wird nur verschärft, nie über die konfigurierten Startwerte hinaus gelockert,
	 * sofern `allowLoosen` nicht gesetzt ist.
	 */
	update(limits: { minIntervalMs?: number; maxConcurrent?: number }, allowLoosen = false): void {
		if (limits.minIntervalMs !== undefined && limits.minIntervalMs >= 0) {
			this.#minIntervalMs = allowLoosen
				? limits.minIntervalMs
				: Math.max(this.#minIntervalMs, limits.minIntervalMs);
		}
		if (limits.maxConcurrent !== undefined && limits.maxConcurrent >= 1) {
			this.#maxConcurrent = allowLoosen
				? limits.maxConcurrent
				: Math.min(this.#maxConcurrent, limits.maxConcurrent);
		}
	}

	#acquire(): Promise<void> {
		const turn = this.#gate.then(() => this.#waitForSlot());
		// Die Warteschlange läuft weiter, auch wenn ein einzelner Turn fehlschlägt.
		this.#gate = turn.catch(() => undefined);
		return turn;
	}

	async #waitForSlot(): Promise<void> {
		const requestedAt = this.#clock.now();
		while (this.#active >= this.#maxConcurrent) {
			await new Promise<void>((resolve) => this.#slotWaiters.push(resolve));
		}
		for (;;) {
			const now = this.#clock.now();
			let earliest = Math.max(this.#lastStart + this.#minIntervalMs, this.#pausedUntil);
			if (this.#spacingFromCompletion && this.#active === 0) {
				earliest = Math.max(earliest, this.#lastEnd + this.#minIntervalMs);
			}
			if (earliest <= now) break;
			await this.#clock.sleep(earliest - now);
		}
		this.#active++;
		this.#lastStart = this.#clock.now();
		this.#onEvent?.({
			type: 'acquire',
			limiter: this.name,
			at: this.#lastStart,
			waitedMs: this.#lastStart - requestedAt,
			active: this.#active
		});
	}

	#release(): void {
		this.#active--;
		this.#lastEnd = this.#clock.now();
		this.#onEvent?.({
			type: 'release',
			limiter: this.name,
			at: this.#lastEnd,
			active: this.#active
		});
		this.#slotWaiters.shift()?.();
	}
}
