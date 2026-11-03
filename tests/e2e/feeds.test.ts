import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import nodemailer from 'nodemailer';
import { createDatabase, type Database } from '../../src/lib/server/db/index';
import { upsertPaper } from '../../src/lib/server/db/papers';
import { runWeeklyDigest } from '../../src/lib/server/digest';
import { createLogger } from '../../src/lib/server/log';
import { runMatching } from '../../src/lib/server/ranking/match';
import { deriveKey } from '../../src/lib/server/tokens';
import {
	E2E_AUTH_SECRET,
	E2E_DATABASE_URL,
	E2E_ORIGIN,
	MAILPIT_URL
} from '../../playwright.config';
import { login } from './helpers';

let database: Database;
test.beforeAll(() => {
	database = createDatabase(E2E_DATABASE_URL, 2);
});
test.afterAll(async () => {
	await database.close();
});

async function subscribeAndSeed(page: Page, tag: string) {
	await page.getByLabel('Suchbegriffe').fill(tag);
	await page.getByRole('button', { name: 'Abo hinzufügen' }).click();
	await expect(page.getByTestId('subscription')).toHaveCount(1);
	for (const [i, title] of [`Feed paper one ${tag}`, `Feed paper two & <more> ${tag}`].entries()) {
		await upsertPaper(database.db, {
			source: 'arxiv',
			ids: { doi: `10.1000/feed.${tag}.${i}` },
			title,
			abstract: `About ${tag}.`,
			abstractLicenseOk: true,
			authors: [{ name: 'Ada Lovelace' }],
			categories: ['cs.DL'],
			publishedAt: new Date(),
			updatedAt: new Date(),
			landingUrl: `https://doi.org/10.1000/feed.${tag}.${i}`
		});
	}
	await runMatching({ db: database.db, logger: createLogger('e2e'), now: () => new Date() });
}

test('Persönlicher RSS/Atom-Feed: aktivieren, abrufen, rotieren, deaktivieren; OPML', async ({
	page,
	request
}) => {
	await login(page, request);
	const tag = `feedtag${Date.now()}`;
	await subscribeAndSeed(page, tag);

	await page.goto('/konto');
	await page.getByRole('button', { name: 'Feed aktivieren' }).click();
	const rssUrl = await page.getByLabel('RSS-Adresse').inputValue();
	const atomUrl = await page.getByLabel('Atom-Adresse').inputValue();
	expect(rssUrl).toMatch(
		/^http:\/\/localhost:4173\/feed\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/rss\.xml$/
	);

	// Feed-Reader rufen ohne Cookies ab → eigener Request-Kontext
	const rss = await request.get(rssUrl);
	expect(rss.status()).toBe(200);
	expect(rss.headers()['content-type']).toBe('application/rss+xml; charset=utf-8');
	expect(rss.headers()['x-robots-tag']).toContain('noindex');
	const rssBody = await rss.text();
	expect(rssBody).toContain('<rss version="2.0"');
	expect(rssBody).toContain(`Feed paper two &amp; &lt;more&gt; ${tag}`);
	expect(rssBody).toContain(`Warum: Stichwort „${tag}“ im Titel`);

	const lastModified = rss.headers()['last-modified'] as string;
	const notModified = await request.get(rssUrl, { headers: { 'If-Modified-Since': lastModified } });
	expect(notModified.status()).toBe(304);

	const atom = await request.get(atomUrl);
	expect(atom.headers()['content-type']).toBe('application/atom+xml; charset=utf-8');
	expect(await atom.text()).toContain('<feed xmlns="http://www.w3.org/2005/Atom"');

	// Manipulierte Adresse → 404
	expect((await request.get(rssUrl.replace(/\.([A-Za-z0-9_-])/, '.X$1'))).status()).toBe(404);

	// OPML mit Gesamtfeed und Feed je Abo
	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page.getByRole('link', { name: 'Alle Feeds als OPML exportieren' }).click()
	]);
	const opml = await readFile((await download.path()) as string, 'utf8');
	expect(opml).toContain('<opml version="2.0">');
	expect(opml).toContain(`xmlUrl="${rssUrl}"`);
	expect(opml).toMatch(new RegExp(`xmlUrl="${rssUrl.replace(/[.?]/g, '\\$&')}\\?abo=\\d+"`));

	// Rotieren: alte Adresse ungültig, neue funktioniert
	page.once('dialog', (d) => d.accept());
	await page.getByRole('button', { name: 'Neue Adresse erzeugen' }).click();
	await expect(page.getByText('Neue Feed-Adresse erzeugt')).toBeVisible();
	const rotated = await page.getByLabel('RSS-Adresse').inputValue();
	expect(rotated).not.toBe(rssUrl);
	expect((await request.get(rssUrl)).status()).toBe(404);
	expect((await request.get(rotated)).status()).toBe(200);

	// Deaktivieren
	await page.getByRole('button', { name: 'Feed deaktivieren' }).click();
	await expect(page.getByRole('button', { name: 'Feed aktivieren' })).toBeVisible();
	expect((await request.get(rotated)).status()).toBe(404);
});

test('Wochen-Mail: Opt-in, Versand mit Abmeldelink, Abmelden per Button und One-Click', async ({
	page,
	request
}) => {
	const email = await login(page, request);
	const tag = `digest${Date.now()}`;
	await subscribeAndSeed(page, tag);

	await page.goto('/konto');
	await expect(page.getByTestId('digest-state')).toHaveText('Wochen-Mail ist ausgeschaltet.');
	await page.getByRole('button', { name: 'Wochen-Mail einschalten' }).click();
	await expect(page.getByTestId('digest-state')).toHaveText('Wochen-Mail ist eingeschaltet.');

	// Versand wie der Worker-Job – über Mailpit
	const transport = nodemailer.createTransport({ host: '127.0.0.1', port: 1025, secure: false });
	const result = await runWeeklyDigest({
		db: database.db,
		logger: createLogger('e2e'),
		now: () => new Date(),
		origin: E2E_ORIGIN,
		key: deriveKey(E2E_AUTH_SECRET, 'digest-unsubscribe'),
		halfLifeDays: 7,
		send: async (mail) => {
			await transport.sendMail({ from: 'Paper-Radar <noreply@example.org>', ...mail });
		}
	});
	expect(result.sent).toBeGreaterThanOrEqual(1);

	let id: string | undefined;
	await expect
		.poll(async () => {
			const res = await request.get(`${MAILPIT_URL}/api/v1/search`, {
				params: { query: `to:"${email}" subject:"wichtigsten Paper"` }
			});
			id = ((await res.json()) as { messages: Array<{ ID: string }> }).messages[0]?.ID;
			return id;
		})
		.toBeTruthy();
	const message = (await (await request.get(`${MAILPIT_URL}/api/v1/message/${id}`)).json()) as {
		Text: string;
		HTML: string;
	};
	expect(message.Text).toContain(`Feed paper one ${tag}`);
	expect(message.HTML).not.toMatch(/<img/i);
	const headers = (await (
		await request.get(`${MAILPIT_URL}/api/v1/message/${id}/headers`)
	).json()) as Record<string, string[]>;
	expect(headers['List-Unsubscribe-Post']).toEqual(['List-Unsubscribe=One-Click']);
	const unsubscribe = /Abmelden: (\S+)/.exec(message.Text)?.[1] as string;
	expect(headers['List-Unsubscribe']).toEqual([`<${unsubscribe}>`]);

	// GET ändert nichts (Link-Scanner), erst der Button meldet ab
	await page.goto(unsubscribe);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Wochen-Mail abbestellen');
	await page.goto('/konto');
	await expect(page.getByTestId('digest-state')).toHaveText('Wochen-Mail ist eingeschaltet.');
	await page.goto(unsubscribe);
	await page.getByRole('button', { name: 'Abbestellen' }).click();
	await expect(page.getByTestId('unsubscribed')).toBeVisible();
	await page.goto('/konto');
	await expect(page.getByTestId('digest-state')).toHaveText('Wochen-Mail ist ausgeschaltet.');

	// Ein-Klick-Abmeldung (RFC 8058): POST vom Mail-Anbieter ohne passende Origin
	await page.getByRole('button', { name: 'Wochen-Mail einschalten' }).click();
	await expect(page.getByTestId('digest-state')).toHaveText('Wochen-Mail ist eingeschaltet.');
	const oneClick = await request.post(unsubscribe, {
		form: { 'List-Unsubscribe': 'One-Click' },
		headers: { Origin: 'https://mail.example.net' },
		maxRedirects: 0
	});
	expect(oneClick.status()).toBe(200);
	await page.reload();
	await expect(page.getByTestId('digest-state')).toHaveText('Wochen-Mail ist ausgeschaltet.');

	// Ungültiger Abmeldelink
	await page.goto('/abmelden/kaputt.token');
	await expect(page.getByRole('alert')).toContainText('ungültig');
});

test('Cross-Site-Formular-POSTs werden außerhalb der Abmeldung abgewiesen', async ({ request }) => {
	for (const path of ['/konto?/digest', '/login', '/paper/1?/state', '/logout']) {
		const res = await request.post(path, {
			form: { enabled: 'true' },
			headers: { Origin: 'https://evil.example' },
			maxRedirects: 0
		});
		expect(res.status(), path).toBe(403);
	}
	const noOrigin = await request.post('/konto?/digest', {
		form: { enabled: 'true' },
		maxRedirects: 0
	});
	expect(noOrigin.status()).toBe(403);
});
