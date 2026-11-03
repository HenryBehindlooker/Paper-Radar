import { describe, expect, it } from 'vitest';
import { ARXIV_CATEGORY_GROUPS, ARXIV_CATEGORY_IDS } from '$lib/arxiv-categories';
import { safeRedirectPath } from '$lib/redirect';
import { loadSmtpConfig, magicLinkMail, SendThrottle } from '$lib/server/mail';
import { parseSubscriptionInput, SubscriptionError } from '$lib/server/subscriptions';
import { isArxivCategory } from '$lib/server/sources/arxiv';

describe('magicLinkMail', () => {
	const now = new Date('2026-11-03T12:00:00Z');
	const url = 'https://radar.example.org/auth/callback/nodemailer?token=abc&email=a%40b.c';

	it('enthält Link, Gültigkeit und keinen Tracking-Inhalt', () => {
		const mail = magicLinkMail(url, new Date(now.getTime() + 60 * 60_000), now);
		expect(mail.subject).toBe('Dein Anmeldelink für Paper-Radar');
		expect(mail.text).toContain(url);
		expect(mail.text).toContain('60 Minuten');
		expect(mail.text).toContain('radar.example.org');
		expect(mail.html).toContain(
			'href="https://radar.example.org/auth/callback/nodemailer?token=abc&amp;email=a%40b.c"'
		);
		expect(mail.html).not.toMatch(/<img|<script|https?:\/\/(?!radar\.example\.org)/i);
	});

	it('maskiert HTML in der URL', () => {
		const mail = magicLinkMail(
			'https://x.org/?a="><script>',
			new Date(now.getTime() + 60_000),
			now
		);
		expect(mail.html).not.toContain('<script>');
		expect(mail.html).toContain('&quot;&gt;&lt;script&gt;');
	});
});

describe('SendThrottle', () => {
	it('begrenzt pro Adresse und gibt nach Ablauf des Fensters wieder frei', () => {
		const t = new SendThrottle(3, 15 * 60_000, 100, 60 * 60_000);
		expect([1, 2, 3, 4].map(() => t.take('a@x.org', 0))).toEqual([true, true, true, false]);
		expect(t.take('b@x.org', 0)).toBe(true);
		expect(t.take('a@x.org', 15 * 60_000)).toBe(true);
	});

	it('begrenzt global', () => {
		const t = new SendThrottle(10, 60_000, 2, 60_000);
		expect(t.take('a', 0)).toBe(true);
		expect(t.take('b', 0)).toBe(true);
		expect(t.take('c', 0)).toBe(false);
		expect(t.take('c', 60_000)).toBe(true);
	});
});

describe('loadSmtpConfig', () => {
	it('Mailpit-Standard ohne Zugangsdaten', () => {
		expect(loadSmtpConfig({ SMTP_HOST: 'localhost', SMTP_PORT: '1025' })).toEqual({
			host: 'localhost',
			port: 1025,
			secure: false,
			from: 'Paper-Radar <noreply@localhost>'
		});
	});

	it('mit Zugangsdaten und TLS', () => {
		expect(
			loadSmtpConfig({
				SMTP_HOST: 'smtp.example.org',
				SMTP_PORT: '465',
				SMTP_SECURE: 'true',
				SMTP_USER: 'u',
				SMTP_PASSWORD: 'p',
				MAIL_FROM: 'Radar <r@example.org>'
			})
		).toEqual({
			host: 'smtp.example.org',
			port: 465,
			secure: true,
			user: 'u',
			password: 'p',
			from: 'Radar <r@example.org>'
		});
	});
});

describe('safeRedirectPath', () => {
	it.each([
		['/abos', '/abos'],
		['/abos?x=1', '/abos?x=1'],
		[null, '/abos'],
		['https://evil.example', '/abos'],
		['//evil.example', '/abos'],
		['/\\evil.example', '/abos'],
		['/ok\r\nSet-Cookie: x', '/abos']
	])('%s → %s', (input, expected) => {
		expect(safeRedirectPath(input)).toBe(expected);
	});
});

describe('parseSubscriptionInput', () => {
	it('akzeptiert gültige Eingaben', () => {
		expect(parseSubscriptionInput({ type: 'keyword', query: ' crispr ', weight: '2' })).toEqual({
			type: 'keyword',
			query: 'crispr',
			weight: 2
		});
		expect(parseSubscriptionInput({ type: 'category', query: 'cs.DL' }).weight).toBe(1);
	});

	it.each([
		[{ type: 'x', query: 'a' }],
		[{ type: 'keyword', query: '   ' }],
		[{ type: 'keyword', query: 'a'.repeat(501) }],
		[{ type: 'category', query: 'cs.XYZ' }],
		[{ type: 'keyword', query: 'a', weight: '7' }]
	])('lehnt %j ab', (input) => {
		expect(() => parseSubscriptionInput(input)).toThrow(SubscriptionError);
	});
});

describe('arXiv-Kategorien', () => {
	it('enthält die Gruppen der Taxonomie mit gültigen IDs', () => {
		expect(ARXIV_CATEGORY_GROUPS.map((g) => g.name)).toContain('Computer Science');
		expect(ARXIV_CATEGORY_IDS.size).toBeGreaterThan(150);
		for (const id of ARXIV_CATEGORY_IDS) expect(isArxivCategory(id)).toBe(true);
		expect(ARXIV_CATEGORY_IDS.has('cs.DL')).toBe(true);
		expect(ARXIV_CATEGORY_IDS.has('hep-th')).toBe(true);
	});
});
