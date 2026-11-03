import { systemClock, type Clock } from './clock';
import { SourceHttpError, SourceNetworkError, SourceRateLimitedError } from './errors';
import type { RateLimiter } from './rate-limiter';
import type { SourceName } from './types';
import { silentLogger, type Logger } from '../log';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpResponse {
	status: number;
	headers: Headers;
	body: string;
	url: string;
}

export interface HttpClientOptions {
	source: SourceName;
	limiter: RateLimiter;
	userAgent: string;
	fetch?: FetchLike;
	clock?: Clock;
	logger?: Logger;
	/** Wiederholungen nach dem ersten Versuch (Standard 3). */
	maxRetries?: number;
	/** Timeout pro Request (Standard 30 s). */
	timeoutMs?: number;
	/** Basis des exponentiellen Backoffs (Standard 2 s). */
	baseBackoffMs?: number;
	/** Obergrenze für einen einzelnen Backoff (Standard 60 s). */
	maxBackoffMs?: number;
	/**
	 * Längste `Retry-After`-Pause, die innerhalb eines Jobs abgewartet wird (Standard 120 s).
	 * Längere Pausen führen zu `SourceRateLimitedError`, damit der Job neu eingeplant wird.
	 */
	maxRetryAfterMs?: number;
	/** Zufallsquelle für Jitter (in Tests deterministisch ersetzbar). */
	random?: () => number;
	/** Hook für jede Antwort (z. B. Header-basierte Limit-Anpassung, Credit-Protokoll). */
	onResponse?: (response: HttpResponse) => void;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Parst `Retry-After` (Sekunden oder HTTP-Datum) in Millisekunden.
 * Gibt `undefined` zurück, wenn der Header fehlt oder ungültig ist.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
	const date = Date.parse(trimmed);
	if (Number.isNaN(date)) return undefined;
	return Math.max(0, date - nowMs);
}

/**
 * HTTP-Client pro Quelle: jeder Versuch läuft durch den Limiter der Quelle,
 * setzt einen eigenen User-Agent, beachtet `Retry-After` und nutzt exponentiellen Backoff.
 * Nicht wiederholbare Status (z. B. 400, 404) werden ohne Exception zurückgegeben.
 */
export class HttpClient {
	readonly #o: Required<
		Omit<HttpClientOptions, 'onResponse' | 'fetch' | 'clock' | 'logger' | 'random'>
	> & {
		fetch: FetchLike;
		clock: Clock;
		logger: Logger;
		random: () => number;
		onResponse?: (response: HttpResponse) => void;
	};

	constructor(options: HttpClientOptions) {
		this.#o = {
			maxRetries: 3,
			timeoutMs: 30_000,
			baseBackoffMs: 2_000,
			maxBackoffMs: 60_000,
			maxRetryAfterMs: 120_000,
			...options,
			fetch: options.fetch ?? ((input, init) => fetch(input, init)),
			clock: options.clock ?? systemClock,
			logger: options.logger ?? silentLogger,
			random: options.random ?? Math.random
		};
	}

	async get(url: string, headers: Record<string, string> = {}): Promise<HttpResponse> {
		const o = this.#o;
		let lastError: unknown;

		for (let attempt = 0; attempt <= o.maxRetries; attempt++) {
			let response: HttpResponse;
			try {
				response = await o.limiter.schedule(() => this.#fetchOnce(url, headers));
			} catch (error) {
				lastError = error;
				o.logger.warn('request failed', {
					source: o.source,
					url: redact(url),
					attempt,
					error: error instanceof Error ? error.message : String(error)
				});
				if (attempt < o.maxRetries) {
					await o.clock.sleep(this.#backoff(attempt));
					continue;
				}
				throw new SourceNetworkError(o.source, `Netzwerkfehler für ${redact(url)}`, {
					cause: error
				});
			}

			o.onResponse?.(response);
			o.logger.debug('response', {
				source: o.source,
				url: redact(url),
				status: response.status,
				attempt
			});

			if (!RETRYABLE_STATUS.has(response.status)) return response;

			const retryAfter = parseRetryAfter(response.headers.get('retry-after'), o.clock.now());
			if (retryAfter !== undefined && retryAfter > o.maxRetryAfterMs) {
				o.limiter.pauseFor(retryAfter);
				throw new SourceRateLimitedError(o.source, retryAfter);
			}
			if (attempt === o.maxRetries) {
				if (response.status === 429) {
					throw new SourceRateLimitedError(o.source, retryAfter ?? this.#backoff(attempt));
				}
				throw new SourceHttpError(o.source, response.status, redact(url), response.body);
			}
			const waitMs = retryAfter ?? this.#backoff(attempt);
			o.logger.warn('retrying', {
				source: o.source,
				url: redact(url),
				status: response.status,
				attempt,
				waitMs
			});
			// Die Pause gilt für die ganze Quelle, nicht nur für diesen Request.
			o.limiter.pauseFor(waitMs);
		}
		/* c8 ignore next */
		throw lastError;
	}

	async #fetchOnce(url: string, headers: Record<string, string>): Promise<HttpResponse> {
		const o = this.#o;
		const res = await o.fetch(url, {
			headers: { 'User-Agent': o.userAgent, ...headers },
			signal: AbortSignal.timeout(o.timeoutMs),
			redirect: 'follow'
		});
		const body = await res.text();
		return { status: res.status, headers: res.headers, body, url };
	}

	#backoff(attempt: number): number {
		const o = this.#o;
		const exp = Math.min(o.maxBackoffMs, o.baseBackoffMs * 2 ** attempt);
		// Jitter: 50–100 % des exponentiellen Werts.
		return Math.round(exp * (0.5 + o.random() * 0.5));
	}
}

/** Entfernt Secrets (API-Keys, mailto) aus URLs für Logs und Fehlermeldungen. */
export function redact(url: string): string {
	return url.replace(/([?&](?:api_key|mailto|email)=)[^&]*/gi, '$1***');
}
