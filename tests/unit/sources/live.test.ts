/**
 * Optionaler Live-Test gegen die echten APIs (wenige Requests, Limits eingehalten).
 * Läuft nur mit `npm run test:live` (setzt LIVE_TESTS=1); nie in CI.
 */
import { describe, expect, it } from 'vitest';
import { loadSourcesConfig } from '$lib/server/config';
import { createLogger } from '$lib/server/log';
import { createSources } from '$lib/server/sources';

const live = process.env.LIVE_TESTS === '1';

describe.skipIf(!live)('Live: Datenquellen', () => {
	const sources = createSources(loadSourcesConfig(), { logger: createLogger('live') });
	const since = new Date(Date.now() - 7 * 86_400_000);

	it('arXiv: Einzelabruf und RSS', { timeout: 60_000 }, async () => {
		const [paper] = await sources.arxiv.getById({ type: 'arxiv', value: 'hep-th/9711200v3' });
		expect(paper?.ids.doi).toBe('10.1023/a:1026654312961');
		const items = await sources.arxiv.fetchDailyAnnouncements(['cs.DL']);
		expect(Array.isArray(items)).toBe(true);
	});

	it('Europe PMC: Keyword-Suche', { timeout: 60_000 }, async () => {
		const papers = await sources.europepmc.search({ kind: 'keyword', value: 'CRISPR' }, since, {
			maxResults: 5
		});
		expect(papers.length).toBeGreaterThan(0);
	});

	it('Crossref: DOI-Lookup', { timeout: 60_000 }, async () => {
		const [paper] = await sources.crossref.getById({ type: 'doi', value: '10.1002/advs.78445' });
		expect(paper?.abstractLicenseOk).toBe(true);
	});

	it.skipIf(!sources.openalex.enabled)('OpenAlex: Einzelabruf', { timeout: 60_000 }, async () => {
		const [paper] = await sources.openalex.getById({
			type: 'doi',
			value: '10.1023/a:1026654312961'
		});
		expect(paper?.citedByCount).toBeGreaterThan(0);
	});
});
