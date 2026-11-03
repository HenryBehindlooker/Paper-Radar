import { expect, test } from '@playwright/test';

test('Startseite lädt', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Paper-Radar');
});

test('Health-Endpunkt antwortet', async ({ request }) => {
	const res = await request.get('/api/health');
	expect(res.status()).toBe(200);
	const body = (await res.json()) as {
		status: string;
		db: { ok: boolean };
		queue: { ok: boolean; queues: Record<string, unknown> };
		sources: Array<{ source: string }>;
	};
	// Ohne laufenden Worker ist der Status „degraded“, DB und Queue müssen erreichbar sein.
	expect(['ok', 'degraded']).toContain(body.status);
	expect(body.db.ok).toBe(true);
	expect(body.queue.ok).toBe(true);
	expect(body.queue.queues).toHaveProperty('ingest-arxiv-daily');
	expect(body.sources.map((s) => s.source).sort()).toEqual([
		'arxiv',
		'crossref',
		'europepmc',
		'openalex'
	]);
	expect(res.headers()['cache-control']).toBe('no-store');
});
