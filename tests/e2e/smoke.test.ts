import { expect, test } from '@playwright/test';

test('Startseite lädt', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Paper-Radar');
});

test('Health-Endpunkt antwortet', async ({ request }) => {
	const res = await request.get('/api/health');
	expect(res.ok()).toBe(true);
	expect(await res.json()).toMatchObject({ status: 'ok' });
});
