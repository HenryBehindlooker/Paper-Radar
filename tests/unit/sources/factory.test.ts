import { describe, expect, it } from 'vitest';
import { userAgent } from '$lib/server/config';
import { silentLogger } from '$lib/server/log';
import { createSources, SOURCE_LIMITS } from '$lib/server/sources';
import { FakeClock, fixture, mockFetch } from './helpers';

describe('createSources', () => {
	it('richtet je Quelle einen eigenen Limiter mit den dokumentierten Limits ein', () => {
		const s = createSources({}, { logger: silentLogger });
		expect(s.limiters.arxiv.minIntervalMs).toBe(3000);
		expect(s.limiters.arxiv.maxConcurrent).toBe(1);
		expect(s.limiters.europepmc.minIntervalMs).toBe(200);
		expect(s.limiters.crossref.minIntervalMs).toBe(SOURCE_LIMITS.crossrefPublic.minIntervalMs);
		expect(s.limiters.crossref.maxConcurrent).toBe(1);
		expect(s.limiters.openalex.minIntervalMs).toBe(100);
		expect(new Set(Object.values(s.limiters)).size).toBe(4);
		expect(s.openalex.enabled).toBe(false);
	});

	it('nutzt mit Kontaktadresse den Crossref-Polite-Pool und einen UA mit mailto', () => {
		const s = createSources(
			{ contactEmail: 'ops@example.org', openalexApiKey: 'k' },
			{ logger: silentLogger }
		);
		expect(s.limiters.crossref.minIntervalMs).toBe(100);
		expect(s.limiters.crossref.maxConcurrent).toBe(3);
		expect(s.openalex.enabled).toBe(true);
		expect(userAgent('ops@example.org')).toBe(
			'Paper-Radar/0.1.0 (+https://github.com/HenryBehindlooker/Paper-Radar; mailto:ops@example.org)'
		);
	});

	it('arXiv-API und arXiv-RSS teilen sich ein Limit: ≥ 3 s zwischen allen Requests', async () => {
		const clock = new FakeClock();
		const fetch = mockFetch(
			(url) => ({
				body: url.includes('rss.arxiv.org')
					? fixture('arxiv/rss-nlin-cg.rss.xml')
					: fixture('arxiv/search-empty.atom.xml')
			}),
			clock
		);
		const s = createSources({}, { fetch, clock, logger: silentLogger });
		await Promise.all([
			s.arxiv.search({ kind: 'category', value: 'cs.DL' }, new Date('2026-10-01T00:00:00Z')),
			s.arxiv.fetchDailyAnnouncements(['nlin.CG']),
			s.arxiv.getById({ type: 'arxiv', value: '2103.00020' }),
			s.arxiv.search({ kind: 'keyword', value: 'graph' }, new Date('2026-10-01T00:00:00Z'))
		]);
		expect(fetch.calls).toHaveLength(4);
		expect(new Set(fetch.calls.map((c) => new URL(c.url).host))).toEqual(
			new Set(['export.arxiv.org', 'rss.arxiv.org'])
		);
		for (let i = 1; i < fetch.calls.length; i++) {
			expect((fetch.calls[i]?.at ?? 0) - (fetch.calls[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(
				3000
			);
		}
	});

	it('Ausfall einer Quelle blockiert die anderen nicht', async () => {
		const clock = new FakeClock();
		const fetch = mockFetch(
			(url) =>
				url.includes('arxiv.org')
					? { status: 503 }
					: { body: fixture('europepmc/search-preprints-core.json') },
			clock
		);
		const s = createSources({}, { fetch, clock, logger: silentLogger });
		const [arxiv, epmc] = await Promise.allSettled([
			s.arxiv.search({ kind: 'keyword', value: 'malaria' }, new Date('2026-10-01T00:00:00Z')),
			s.europepmc.search({ kind: 'keyword', value: 'malaria' }, new Date('2026-10-01T00:00:00Z'))
		]);
		expect(arxiv.status).toBe('rejected');
		expect(epmc.status).toBe('fulfilled');
	});
});
