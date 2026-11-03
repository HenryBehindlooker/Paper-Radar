import { readFile } from 'node:fs/promises';
import { expect, test, type Locator } from '@playwright/test';
import { createDatabase, type Database } from '../../src/lib/server/db/index';
import { upsertPaper } from '../../src/lib/server/db/papers';
import { createLogger } from '../../src/lib/server/log';
import { runMatching } from '../../src/lib/server/ranking/match';
import { E2E_DATABASE_URL } from '../../playwright.config';
import { login } from './helpers';

let database: Database;
test.beforeAll(() => {
	database = createDatabase(E2E_DATABASE_URL, 2);
});
test.afterAll(async () => {
	await database.close();
});

/** Legt Paper in der E2E-Datenbank an und berechnet die Treffer (wie Worker-Jobs). */
async function seedPapers(tag: string) {
	const now = new Date();
	const day = 86_400_000;
	const base = {
		source: 'arxiv' as const,
		categories: ['cs.DL'],
		abstractLicenseOk: false,
		updatedAt: now,
		authors: [{ name: 'Ada Lovelace' }, { name: 'Jörg Müller' }]
	};
	const n = Date.now() % 100000;
	const first = await upsertPaper(database.db, {
		...base,
		ids: {
			arxivId: `2611.${String(10000 + (n % 80000)).padStart(5, '0')}`,
			doi: `10.1000/e2e.${tag}`
		},
		title: `Open citation graphs ${tag}`,
		abstract: 'We study open citation graphs.\n\nSecond paragraph with $\\alpha$.',
		abstractLicenseOk: true,
		publishedAt: now,
		landingUrl: 'https://arxiv.org/abs/2611.00001',
		pdfUrl: 'https://arxiv.org/pdf/2611.00001'
	});
	const second = await upsertPaper(database.db, {
		...base,
		ids: { doi: `10.1000/e2e.${tag}.b` },
		source: 'crossref',
		title: `Moduli of $\\mathbb P^3$ sheaves ${tag}`,
		abstract: 'Closed abstract.',
		abstractLicenseOk: false,
		journal: 'Journal of Tests',
		publishedAt: new Date(now.getTime() - day),
		landingUrl: `https://doi.org/10.1000/e2e.${tag}.b`
	});
	const third = await upsertPaper(database.db, {
		...base,
		ids: { doi: `10.1000/e2e.${tag}.c` },
		title: `Library metrics revisited ${tag}`,
		publishedAt: new Date(now.getTime() - 2 * day),
		landingUrl: `https://doi.org/10.1000/e2e.${tag}.c`
	});
	await runMatching({ db: database.db, logger: createLogger('e2e'), now: () => new Date() });
	return [first.paperId, second.paperId, third.paperId];
}

const pressed = (button: Locator) => expect(button).toHaveAttribute('aria-pressed', 'true');

test('Feed-Karten, Aktionen, Merkliste, Detail, BibTeX, Suche', async ({ page, request }) => {
	await login(page, request);
	await page.getByLabel('arXiv-Kategorie').check();
	await page.getByLabel('Kategorie', { exact: true }).selectOption('cs.DL');
	await page.getByRole('button', { name: 'Abo hinzufügen' }).click();
	await expect(page.getByTestId('subscription')).toHaveCount(1);

	const tag = `t${Date.now()}`;
	await seedPapers(tag);

	await page.goto('/');
	const cards = page.getByTestId('paper-card').filter({ hasText: tag });
	await expect(cards).toHaveCount(3);
	const byTitle = (title: string) => page.getByTestId('paper-card').filter({ hasText: title });
	const first = byTitle(`Open citation graphs ${tag}`);
	const second = byTitle(`sheaves ${tag}`);
	const third = byTitle(`Library metrics revisited ${tag}`);
	await expect(cards.nth(0)).toContainText(`Open citation graphs ${tag}`);
	await expect(first).toContainText(`Open citation graphs ${tag}`);
	await expect(first).toContainText('Ada Lovelace, Jörg Müller');
	await expect(first).toContainText('arXiv');

	// Abstract ausklappbar (nur bei offener Lizenz), Begründung sichtbar
	await first.getByText('Abstract', { exact: true }).click();
	await expect(first).toContainText('Second paragraph');
	await expect(second.getByText('Abstract', { exact: true })).toHaveCount(0);
	await first.getByText('Warum sehe ich das?').click();
	await expect(first.getByRole('listitem')).toHaveText(['arXiv-Kategorie cs.DL']);

	// Gelesen → Filter „Ungelesen“
	await first.getByRole('button', { name: 'Gelesen' }).click();
	await pressed(first.getByRole('button', { name: 'Als ungelesen markieren' }));
	await page.getByRole('link', { name: 'Ungelesen' }).click();
	await expect(page).toHaveURL(/\?filter=ungelesen$/);
	await expect(page.getByTestId('paper-card').filter({ hasText: tag })).toHaveCount(2);
	await expect(first).toHaveCount(0);
	await page.getByRole('link', { name: 'Alle', exact: true }).click();
	await expect(page).toHaveURL(/\/$/);
	await expect(cards).toHaveCount(3);

	// Merken → Merkliste
	await second.getByRole('button', { name: 'Merken' }).click();
	await pressed(second.getByRole('button', { name: 'Gemerkt' }));

	// Ausblenden → verschwindet, unter „Ausgeblendet“ wieder einblendbar
	await third.getByRole('button', { name: 'Ausblenden' }).click();
	await expect(page.getByTestId('paper-card').filter({ hasText: tag })).toHaveCount(2);
	await page.getByRole('link', { name: 'Ausgeblendet' }).click();
	await expect(page).toHaveURL(/\?filter=ausgeblendet$/);
	const hiddenCard = page.getByTestId('paper-card').filter({ hasText: tag });
	await expect(hiddenCard).toHaveCount(1);
	await hiddenCard.getByRole('button', { name: 'Wieder einblenden' }).click();
	await expect(page.getByTestId('paper-card').filter({ hasText: tag })).toHaveCount(0);

	await page.getByRole('link', { name: 'Merkliste' }).click();
	await expect(page).toHaveURL(/\/merkliste$/);
	const saved = page.getByTestId('paper-card');
	await expect(saved).toHaveCount(1);
	await expect(saved).toContainText(`Moduli of $\\mathbb P^3$ sheaves ${tag}`);
	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page.getByRole('link', { name: 'Merkliste als BibTeX exportieren' }).click()
	]);
	expect(download.suggestedFilename()).toBe('paper-radar-merkliste.bib');
	const bib = await readFile((await download.path()) as string, 'utf8');
	expect(bib).toMatch(/^@article\{lovelace\d{4}moduli,/);
	expect(bib).toContain('title = {{Moduli of $\\mathbb P^3$ sheaves');
	expect(bib).toContain('author = {Lovelace, Ada and Müller, Jörg}');
	expect(bib).toContain('journal = {Journal of Tests}');

	// Detailseite: Links aus allen IDs, PDF nur als Verweis, Einzel-BibTeX
	await page.goto('/');
	await page.getByRole('link', { name: `Open citation graphs ${tag}` }).click();
	await expect(page).toHaveURL(/\/paper\/\d+$/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Open citation graphs ${tag}`);
	const links = page.getByTestId('paper-links');
	await expect(links.getByRole('link', { name: /^arXiv:/ })).toHaveAttribute(
		'href',
		/^https:\/\/arxiv\.org\/abs\//
	);
	await expect(links.getByRole('link', { name: /^DOI 10\.1000\/e2e/ })).toHaveAttribute(
		'href',
		`https://doi.org/10.1000/e2e.${tag}`
	);
	await expect(links.getByRole('link', { name: /PDF \(extern\)/ })).toHaveAttribute(
		'rel',
		/noopener/
	);
	await expect(page.getByText('Paper-Radar speichert keine PDFs')).toBeVisible();
	const [single] = await Promise.all([
		page.waitForEvent('download'),
		page.getByRole('link', { name: 'BibTeX herunterladen' }).click()
	]);
	const one = await readFile((await single.path()) as string, 'utf8');
	expect(one).toContain('eprint = {2611.');
	expect(one).toContain('archiveprefix = {arXiv}');

	// Suche über die eigene Datenbank
	await page.getByRole('link', { name: 'Suche' }).click();
	await page.getByLabel('In allen gespeicherten Papern suchen').fill(`"library metrics" ${tag}`);
	await page.getByRole('button', { name: 'Suchen' }).click();
	await expect(page).toHaveURL(/\/suche\?q=/);
	await expect(page.getByTestId('paper-card')).toHaveCount(1);
	await expect(page.getByTestId('paper-card')).toContainText(`Library metrics revisited ${tag}`);
	await page.getByLabel('In allen gespeicherten Papern suchen').fill('zzqqxx-nichts');
	await page.getByRole('button', { name: 'Suchen' }).click();
	await expect(page.getByText('Keine Treffer')).toBeVisible();

	// Unbekanntes Paper → 404
	expect((await page.request.get('/paper/999999999')).status()).toBe(404);
});

test('Aktionen funktionieren auch ohne JavaScript', async ({ browser, page, request }) => {
	await login(page, request);
	await page.getByLabel('arXiv-Kategorie').check();
	await page.getByLabel('Kategorie', { exact: true }).selectOption('cs.DL');
	await page.getByRole('button', { name: 'Abo hinzufügen' }).click();
	await expect(page.getByTestId('subscription')).toHaveCount(1);
	const tag = `nojs${Date.now()}`;
	await seedPapers(tag);

	const context = await browser.newContext({
		javaScriptEnabled: false,
		storageState: await page.context().storageState()
	});
	const noJs = await context.newPage();
	await noJs.goto('/');
	const card = noJs.getByTestId('paper-card').filter({ hasText: `Open citation graphs ${tag}` });
	await card.getByRole('button', { name: 'Merken' }).click();
	await expect(noJs).toHaveURL(/\/$/);
	await pressed(
		noJs
			.getByTestId('paper-card')
			.filter({ hasText: `Open citation graphs ${tag}` })
			.getByRole('button', { name: 'Gemerkt' })
	);
	await context.close();
});

test('Über-Seite, Pflicht-Fußzeile, Farbschema und Handybreite', async ({ page }) => {
	await page.setViewportSize({ width: 360, height: 740 });
	await page.goto('/ueber');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Über Paper-Radar');
	for (const heading of ['Datenquellen', 'So entsteht die Reihenfolge', 'Datenschutz']) {
		await expect(page.getByRole('heading', { name: heading })).toBeVisible();
	}
	await expect(page.getByTestId('arxiv-attribution')).toHaveText(
		'Thank you to arXiv for use of its open access interoperability.'
	);
	await expect(page.locator('footer')).toContainText(
		'Europe PMC (EMBL-EBI), Crossref und OpenAlex'
	);

	// Keine horizontale Scrollleiste auf schmalen Geräten
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(0);

	// Farbschema: automatisch → hell → dunkel, bleibt nach Neuladen erhalten
	const toggle = page.getByTestId('theme-toggle');
	await expect(toggle).toHaveText('Farbschema: Automatisch');
	await toggle.click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	await toggle.click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	await expect(toggle).toHaveText('Farbschema: Dunkel');
	const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
	expect(bg).toBe('rgb(18, 20, 24)');

	// Keine Ressourcen von Drittanbietern
	const external: string[] = [];
	page.on('request', (r) => {
		if (!r.url().startsWith('http://localhost')) external.push(r.url());
	});
	await page.goto('/');
	await page.goto('/ueber');
	expect(external).toEqual([]);
});
