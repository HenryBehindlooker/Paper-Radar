import { userAgent, type SourcesConfig } from '../config';
import { createLogger, type Logger } from '../log';
import { ArxivSource } from './arxiv';
import type { Clock } from './clock';
import { applyCrossrefRateHeaders, CrossrefSource } from './crossref';
import { EuropePmcSource } from './europepmc';
import { HttpClient, type FetchLike } from './http';
import { createOpenAlexResponseHook, OpenAlexSource, type OpenAlexUsage } from './openalex';
import { RateLimiter, type RateLimiterEvent } from './rate-limiter';
import type { SourceName } from './types';

export * from './types';
export * from './errors';
export { ArxivSource } from './arxiv';
export { EuropePmcSource } from './europepmc';
export { CrossrefSource } from './crossref';
export { OpenAlexSource } from './openalex';
export type { OpenAlexUsage } from './openalex';

/**
 * Rate-Limits je Quelle. Begründung und Belege: docs/DATA_SOURCES.md.
 * Jede Quelle hat genau einen Limiter, über den alle Requests (auch Retries) laufen.
 */
export const SOURCE_LIMITS = {
	/** ToU: „no more than one request every three seconds … a single connection at a time“. */
	arxiv: { minIntervalMs: 3000, maxConcurrent: 1, spacingFromCompletion: true },
	/** Kein offizielles Limit auffindbar → konservativ 5 req/s, eine Verbindung. */
	europepmc: { minIntervalMs: 200, maxConcurrent: 1, spacingFromCompletion: false },
	/** Public Pool: 5 req/s, 1 parallel; Listen nur 1 req/s (Header passen das live an). */
	crossrefPublic: { minIntervalMs: 200, maxConcurrent: 1, spacingFromCompletion: false },
	/** Polite Pool (mit mailto): 10 req/s, 3 parallel. */
	crossrefPolite: { minIntervalMs: 100, maxConcurrent: 3, spacingFromCompletion: false },
	/** Doku: 10 req/s ohne Key, 30 mit Key → wir bleiben bei 10 req/s, eine Verbindung. */
	openalex: { minIntervalMs: 100, maxConcurrent: 1, spacingFromCompletion: false }
} as const;

export interface CreateSourcesDeps {
	fetch?: FetchLike;
	clock?: Clock;
	logger?: Logger;
	onOpenAlexUsage?: (usage: OpenAlexUsage) => void;
}

export interface Sources {
	arxiv: ArxivSource;
	europepmc: EuropePmcSource;
	crossref: CrossrefSource;
	openalex: OpenAlexSource;
	limiters: Record<SourceName, RateLimiter>;
}

export function createSources(config: SourcesConfig, deps: CreateSourcesDeps = {}): Sources {
	const logger = deps.logger ?? createLogger('sources');
	const ua = userAgent(config.contactEmail);
	const onEvent = (event: RateLimiterEvent) => {
		if (event.type === 'acquire') {
			logger.debug('rate-limit slot', {
				limiter: event.limiter,
				waitedMs: event.waitedMs,
				active: event.active
			});
		} else if (event.type === 'pause') {
			logger.info('rate-limit pause', { limiter: event.limiter, untilMs: event.until });
		}
	};
	const limiter = (name: SourceName, limits: (typeof SOURCE_LIMITS)[keyof typeof SOURCE_LIMITS]) =>
		new RateLimiter({ name, ...limits, onEvent, ...(deps.clock ? { clock: deps.clock } : {}) });

	const limiters: Record<SourceName, RateLimiter> = {
		arxiv: limiter('arxiv', SOURCE_LIMITS.arxiv),
		europepmc: limiter('europepmc', SOURCE_LIMITS.europepmc),
		crossref: limiter(
			'crossref',
			config.contactEmail ? SOURCE_LIMITS.crossrefPolite : SOURCE_LIMITS.crossrefPublic
		),
		openalex: limiter('openalex', SOURCE_LIMITS.openalex)
	};

	const http = (
		source: SourceName,
		extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}
	) =>
		new HttpClient({
			source,
			limiter: limiters[source],
			userAgent: ua,
			logger: logger.child(source),
			...(deps.fetch ? { fetch: deps.fetch } : {}),
			...(deps.clock ? { clock: deps.clock } : {}),
			...extra
		});

	return {
		arxiv: new ArxivSource({ http: http('arxiv', { baseBackoffMs: 5000 }) }),
		europepmc: new EuropePmcSource({ http: http('europepmc') }),
		crossref: new CrossrefSource({
			http: http('crossref', {
				onResponse: (res) => applyCrossrefRateHeaders(limiters.crossref, res)
			}),
			...(config.contactEmail ? { mailto: config.contactEmail } : {})
		}),
		openalex: new OpenAlexSource({
			http: http('openalex', { onResponse: createOpenAlexResponseHook(deps.onOpenAlexUsage) }),
			...(config.openalexApiKey ? { apiKey: config.openalexApiKey } : {})
		}),
		limiters
	};
}
