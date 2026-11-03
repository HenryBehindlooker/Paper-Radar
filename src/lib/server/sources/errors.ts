import type { SourceName } from './types';

export class SourceError extends Error {
	constructor(
		readonly source: SourceName,
		message: string,
		options?: { cause?: unknown }
	) {
		super(`[${source}] ${message}`, options);
		this.name = new.target.name;
	}
}

/** Upstream hat mit einem unerwarteten HTTP-Status geantwortet (nach allen Retries). */
export class SourceHttpError extends SourceError {
	constructor(
		source: SourceName,
		readonly status: number,
		readonly url: string,
		readonly body?: string
	) {
		super(source, `HTTP ${status} für ${url}`);
	}
}

/** Netzwerkfehler oder Timeout (nach allen Retries). */
export class SourceNetworkError extends SourceError {}

/** Antwort ließ sich nicht parsen. */
export class SourceParseError extends SourceError {}

/**
 * Upstream verlangt eine Pause, die länger ist, als ein Job warten sollte.
 * Der Aufrufer (pg-boss-Job) sollte den Lauf nach `retryAfterMs` neu einplanen.
 */
export class SourceRateLimitedError extends SourceError {
	constructor(
		source: SourceName,
		readonly retryAfterMs: number
	) {
		super(source, `Rate-Limit erreicht, erneut versuchen in ${Math.ceil(retryAfterMs / 1000)} s`);
	}
}

/** Tages-/Credit-Budget aufgebraucht – sauber pausieren statt erneut zu versuchen. */
export class SourceBudgetExhaustedError extends SourceError {}

/** Quelle ist nicht konfiguriert (z. B. fehlender API-Key). */
export class SourceDisabledError extends SourceError {}
