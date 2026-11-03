import { expect, test } from '@playwright/test';
import { magicLink } from './helpers';

test('Magic-Link-Login, Abos verwalten und Konto löschen', async ({ page, request }) => {
	const email = `e2e-${Date.now()}@example.org`;

	// Geschützte Seite → Login mit Rücksprungziel
	await page.goto('/abos');
	await expect(page).toHaveURL(/\/login\?redirectTo=%2Fabos$/);

	await page.getByLabel('E-Mail-Adresse').fill(email);
	await page.getByRole('button', { name: 'Anmeldelink senden' }).click();
	await expect(page).toHaveURL(/\/login\/mail-gesendet/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Prüfe dein Postfach');

	const link = await magicLink(request, email);
	await page.goto(link);
	await expect(page).toHaveURL(/\/abos$/);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Deine Abos');

	// Startseite zeigt angemeldet den (noch leeren) persönlichen Feed
	await page.goto('/');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Neu für dich');
	await expect(page.getByText('Noch keine Treffer')).toBeVisible();
	await page.goto('/abos');

	// Session-Cookie: httpOnly, sameSite=lax
	const cookies = await page.context().cookies();
	const session = cookies.find((c) => c.name.endsWith('authjs.session-token'));
	expect(session?.httpOnly).toBe(true);
	expect(session?.sameSite).toBe('Lax');

	// Stichwort-Abo → Backfill wird eingeplant (ohne Worker bleibt es „eingeplant“)
	await page.getByLabel('Suchbegriffe').fill('graph neural networks');
	await page.getByRole('button', { name: 'Abo hinzufügen' }).click();
	const items = page.getByTestId('subscription');
	await expect(items).toHaveCount(1);
	await expect(items.first()).toContainText('graph neural networks');
	await expect(items.first().getByTestId('backfill-status')).toHaveText('Nachladen eingeplant …');
	// Gewählte Abo-Art bleibt nach dem Absenden erhalten, das Feld ist geleert.
	await expect(page.getByLabel('Stichwort')).toBeChecked();
	await expect(page.getByLabel('Suchbegriffe')).toHaveValue('');

	// Kategorie-Abo über die Auswahlliste
	await page.getByLabel('arXiv-Kategorie').check();
	await page.getByLabel('Kategorie', { exact: true }).selectOption('cs.DL');
	await page.getByRole('button', { name: 'Abo hinzufügen' }).click();
	await expect(items).toHaveCount(2);
	await expect(items.nth(1)).toContainText('cs.DL – Digital Libraries');
	await expect(page.getByLabel('arXiv-Kategorie')).toBeChecked();
	await expect(page.getByLabel('Kategorie', { exact: true })).toBeVisible();

	// Ungültige Eingabe → Fehlermeldung
	await page.getByLabel('Stichwort').check();
	await page.getByLabel('Suchbegriffe').fill('-nur -ausschluss');
	await page.getByRole('button', { name: 'Abo hinzufügen' }).click();
	await expect(page.getByRole('alert')).toContainText('mindestens einen Suchbegriff');

	// Abo entfernen
	page.once('dialog', (d) => d.accept());
	await items.nth(1).getByRole('button', { name: 'Entfernen' }).click();
	await expect(items).toHaveCount(1);

	// JSON-API liefert die eigenen Abos
	const api = await page.request.get('/api/subscriptions');
	expect(api.status()).toBe(200);
	expect(((await api.json()) as { subscriptions: unknown[] }).subscriptions).toHaveLength(1);

	// Konto löschen (DSGVO)
	await page.goto('/konto');
	await expect(page.getByTestId('account-email')).toHaveText(email);
	await page.getByLabel('Zur Bestätigung').fill('falsch@example.org');
	await page.getByRole('button', { name: 'Konto endgültig löschen' }).click();
	await expect(page.getByRole('alert')).toContainText('stimmt nicht überein');
	await page.getByLabel('Zur Bestätigung').fill(email);
	await page.getByRole('button', { name: 'Konto endgültig löschen' }).click();
	await expect(page).toHaveURL(/\/\?konto=geloescht$/);
	await expect(page.getByRole('status')).toContainText('gelöscht');

	// Danach ist man abgemeldet, und der alte Link ist ungültig.
	await page.goto('/abos');
	await expect(page).toHaveURL(/\/login/);
	await page.goto(link);
	await expect(page).toHaveURL(/\/login\/fehler\?error=Verification/);
	expect((await page.request.get('/api/subscriptions')).status()).toBe(401);
});
