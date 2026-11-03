import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { MAILPIT_URL } from '../../playwright.config';

interface MailpitSummary {
	ID: string;
}

/** Holt den Magic-Link aus der zuletzt an `email` gesendeten Mail (Mailpit-API). */
export async function magicLink(request: APIRequestContext, email: string): Promise<string> {
	let id: string | undefined;
	await expect
		.poll(
			async () => {
				const res = await request.get(`${MAILPIT_URL}/api/v1/search`, {
					params: { query: `to:"${email}"` }
				});
				const { messages } = (await res.json()) as { messages: MailpitSummary[] };
				id = messages[0]?.ID;
				return id;
			},
			{ timeout: 15_000 }
		)
		.toBeTruthy();
	const res = await request.get(`${MAILPIT_URL}/api/v1/message/${id}`);
	const message = (await res.json()) as { Text: string; Subject: string; HTML: string };
	expect(message.Subject).toBe('Dein Anmeldelink für Paper-Radar');
	expect(message.HTML).not.toMatch(/<img/i);
	const url = /(http:\/\/localhost:\d+\/auth\/callback\/nodemailer\?\S+)/.exec(message.Text)?.[1];
	expect(url).toBeTruthy();
	return url as string;
}

/** Meldet sich mit einer neuen Adresse an und landet auf `redirectTo`. */
export async function login(page: Page, request: APIRequestContext, redirectTo = '/abos') {
	const email = `e2e-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.org`;
	await page.goto(`/login?redirectTo=${encodeURIComponent(redirectTo)}`);
	await page.getByLabel('E-Mail-Adresse').fill(email);
	await page.getByRole('button', { name: 'Anmeldelink senden' }).click();
	await expect(page).toHaveURL(/\/login\/mail-gesendet/);
	await page.goto(await magicLink(request, email));
	return email;
}
