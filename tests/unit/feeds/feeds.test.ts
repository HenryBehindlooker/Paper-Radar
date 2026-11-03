import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { isForbiddenCrossSiteRequest, isFormContentType } from '$lib/server/csrf';
import { digestMail } from '$lib/server/digest';
import {
	buildAtom,
	buildOpml,
	buildRss,
	escapeXml,
	rfc822,
	type FeedEntry
} from '$lib/server/feeds/xml';
import type { PaperCard } from '$lib/server/papers-view';
import { deriveKey, newFeedId, signToken, verifyToken } from '$lib/server/tokens';

const SECRET = 'test-secret-0123456789-abcdefghij';

describe('Tokens', () => {
	const key = deriveKey(SECRET, 'feed');

	it('Signatur prüfen: gültig, manipuliert, falscher Zweck, kaputt', () => {
		const id = newFeedId();
		const token = signToken(key, id);
		expect(verifyToken(key, token)).toBe(id);
		expect(verifyToken(key, `${id}x.${token.split('.')[1]}`)).toBeNull();
		expect(verifyToken(key, `${token.slice(0, -2)}AA`)).toBeNull();
		expect(verifyToken(deriveKey(SECRET, 'digest-unsubscribe'), token)).toBeNull();
		expect(verifyToken(deriveKey(`${SECRET}!`, 'feed'), token)).toBeNull();
		for (const bad of ['', '.', 'abc', 'abc.', '.sig', 'a'.repeat(400)]) {
			expect(verifyToken(key, bad)).toBeNull();
		}
	});

	it('Feed-IDs sind zufällig und URL-sicher', () => {
		const ids = new Set(Array.from({ length: 100 }, newFeedId));
		expect(ids.size).toBe(100);
		for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
	});

	it('verlangt ein ausreichend langes Secret; Payload ohne Punkt', () => {
		expect(() => deriveKey('', 'feed')).toThrow(/AUTH_SECRET/);
		expect(() => deriveKey('short', 'feed')).toThrow();
		expect(() => signToken(key, 'a.b')).toThrow();
	});
});

const entry = (i: number, overrides: Partial<FeedEntry> = {}): FeedEntry => ({
	id: `urn:paper-radar:paper:${i}`,
	title: `Paper ${i}`,
	link: `https://arxiv.org/abs/2611.0000${i}`,
	summary: `Summary ${i}`,
	authors: ['Ada Lovelace', 'Jörg Müller'],
	published: new Date(Date.UTC(2026, 10, i, 6)),
	updated: new Date(Date.UTC(2026, 10, i, 6)),
	categories: ['cs.DL'],
	...overrides
});
const meta = {
	title: 'Paper-Radar – alle Treffer',
	description: 'Test & <Feed>',
	homeUrl: 'https://radar.example.org',
	selfUrl: 'https://radar.example.org/feed/abc.def/rss.xml?abo=1&x=2',
	updated: new Date('2026-11-03T06:00:00Z'),
	generator: 'Paper-Radar 0.1.0'
};
const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '@_',
	parseTagValue: false,
	isArray: (n) => ['item', 'entry', 'outline', 'author', 'category'].includes(n)
});

describe('XML', () => {
	it('escapeXml maskiert und entfernt in XML verbotene Zeichen', () => {
		expect(escapeXml(`a & b < c > "d" 'e'`)).toBe(
			'a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;'
		);
		expect(escapeXml('x\u0000y\u0008z\u000B￾\tok\n')).toBe('xyz\tok\n');
		expect(escapeXml('lone \uD800 surrogate, pair 😀')).toBe('lone  surrogate, pair 😀');
	});

	it('rfc822', () => {
		expect(rfc822(new Date('2026-11-03T06:05:09Z'))).toBe('Tue, 03 Nov 2026 06:05:09 GMT');
	});

	it('RSS 2.0 ist wohlgeformt und enthält Pflichtelemente', () => {
		const xml = buildRss(meta, [
			entry(1, { title: 'Sheaves on $\\mathbb P^3$ & <Quot>', summary: 'Line 1\nLine 2 <b>' }),
			entry(2)
		]);
		expect(XMLValidator.validate(xml)).toBe(true);
		const rss = parser.parse(xml).rss;
		expect(rss['@_version']).toBe('2.0');
		const channel = rss.channel;
		expect(channel.title).toBe('Paper-Radar – alle Treffer');
		expect(channel.description).toBe('Test & <Feed>');
		expect(channel['atom:link']['@_href']).toBe(meta.selfUrl);
		expect(channel.item).toHaveLength(2);
		expect(channel.item[0].title).toBe('Sheaves on $\\mathbb P^3$ & <Quot>');
		expect(channel.item[0].description).toBe('Line 1\nLine 2 <b>');
		expect(channel.item[0].guid['#text']).toBe('urn:paper-radar:paper:1');
		expect(channel.item[0].pubDate).toBe('Sun, 01 Nov 2026 06:00:00 GMT');
		expect(channel.item[0]['dc:creator']).toBe('Ada Lovelace, Jörg Müller');
	});

	it('Atom 1.0 ist wohlgeformt, Autor-Pflicht auch ohne Autoren erfüllt', () => {
		const xml = buildAtom(meta, [entry(1), entry(2, { authors: [] })]);
		expect(XMLValidator.validate(xml)).toBe(true);
		const feed = parser.parse(xml).feed;
		expect(feed['@_xmlns']).toBe('http://www.w3.org/2005/Atom');
		expect(feed.id).toBe(meta.selfUrl);
		expect(feed.entry).toHaveLength(2);
		expect(feed.entry[0].author.map((a: { name: string }) => a.name)).toEqual([
			'Ada Lovelace',
			'Jörg Müller'
		]);
		expect(feed.entry[1].author[0].name).toBe('Unbekannt');
		expect(feed.entry[0].updated).toBe('2026-11-01T06:00:00.000Z');
		expect(feed.entry[0].category[0]['@_term']).toBe('cs.DL');
	});

	it('leere Feeds sind gültig', () => {
		expect(XMLValidator.validate(buildRss(meta, []))).toBe(true);
		expect(XMLValidator.validate(buildAtom(meta, []))).toBe(true);
	});

	it('OPML 2.0 mit allen Feeds', () => {
		const xml = buildOpml('Meine Feeds', meta.updated, [
			{ title: 'Alle', xmlUrl: 'https://r.example/feed/t/rss.xml', htmlUrl: 'https://r.example' },
			{
				title: 'Stichwort: "a & b"',
				xmlUrl: 'https://r.example/feed/t/rss.xml?abo=3',
				htmlUrl: 'https://r.example'
			}
		]);
		expect(XMLValidator.validate(xml)).toBe(true);
		const outlines = parser.parse(xml).opml.body.outline[0].outline;
		expect(
			outlines.map((o: Record<string, string>) => [o['@_text'], o['@_xmlUrl'], o['@_type']])
		).toEqual([
			['Alle', 'https://r.example/feed/t/rss.xml', 'rss'],
			['Stichwort: "a & b"', 'https://r.example/feed/t/rss.xml?abo=3', 'rss']
		]);
	});
});

describe('CSRF-Regel', () => {
	const url = new URL('https://radar.example.org/konto?/digest');
	const req = (method: string, type: string | null, origin: string | null) => {
		const headers = new Headers();
		if (type) headers.set('content-type', type);
		if (origin) headers.set('origin', origin);
		return { method, headers };
	};

	it('blockiert fremde und fehlende Origins bei Formular-POSTs', () => {
		expect(
			isForbiddenCrossSiteRequest(
				req('POST', 'application/x-www-form-urlencoded', 'https://evil.example'),
				url
			)
		).toBe(true);
		expect(
			isForbiddenCrossSiteRequest(req('POST', 'multipart/form-data; boundary=x', null), url)
		).toBe(true);
		expect(
			isForbiddenCrossSiteRequest(req('DELETE', 'text/plain', 'https://evil.example'), url)
		).toBe(true);
	});

	it('erlaubt gleiche Origin, GET und Nicht-Formular-Typen', () => {
		expect(
			isForbiddenCrossSiteRequest(
				req('POST', 'application/x-www-form-urlencoded', 'https://radar.example.org'),
				url
			)
		).toBe(false);
		expect(
			isForbiddenCrossSiteRequest(
				req('GET', 'application/x-www-form-urlencoded', 'https://evil.example'),
				url
			)
		).toBe(false);
		expect(
			isForbiddenCrossSiteRequest(req('POST', 'application/json', 'https://evil.example'), url)
		).toBe(false);
	});

	it('Ausnahme nur für die Ein-Klick-Abmeldung', () => {
		const unsub = new URL('https://radar.example.org/abmelden/abc-123.SIG_x');
		expect(
			isForbiddenCrossSiteRequest(req('POST', 'application/x-www-form-urlencoded', null), unsub)
		).toBe(false);
		const nested = new URL('https://radar.example.org/abmelden/abc/extra');
		expect(
			isForbiddenCrossSiteRequest(req('POST', 'application/x-www-form-urlencoded', null), nested)
		).toBe(true);
		expect(isFormContentType('Application/X-WWW-Form-Urlencoded; charset=utf-8')).toBe(true);
	});
});

describe('digestMail', () => {
	const card = (i: number): PaperCard => ({
		paperId: i,
		title: i === 1 ? 'Graphs & <Trees>' : `Paper ${i}`,
		authors: ['Ada Lovelace'],
		authorCount: 3,
		publishedAt: new Date('2026-11-01T00:00:00Z'),
		journal: null,
		abstract: null,
		sources: ['arxiv'],
		categories: ['cs.DL'],
		landingUrl: `https://arxiv.org/abs/${i}`,
		ids: {},
		pdfUrl: null,
		citedByCount: null,
		reasons: [
			{ subscriptionId: 1, type: 'category', query: 'cs.DL', weight: 1, contribution: 0.3 }
		],
		seen: false,
		saved: false,
		hidden: false,
		score: 1
	});

	it('enthält Liste, Begründung, Abmeldelink und One-Click-Header', () => {
		const unsubscribe = 'https://radar.example.org/abmelden/uid.sig';
		const mail = digestMail([card(1), card(2)], {
			origin: 'https://radar.example.org/',
			unsubscribeUrl: unsubscribe,
			now: new Date()
		});
		expect(mail.subject).toBe('Paper-Radar: Deine 2 wichtigsten Paper der Woche');
		expect(mail.text).toContain('1. Graphs & <Trees>');
		expect(mail.text).toContain('Ada Lovelace u. a. · 01.11.2026');
		expect(mail.text).toContain('Warum: arXiv-Kategorie cs.DL');
		expect(mail.text).toContain('https://radar.example.org/paper/2');
		expect(mail.text).toContain(`Abmelden: ${unsubscribe}`);
		expect(mail.html).toContain('Graphs &amp; &lt;Trees&gt;');
		expect(mail.html).toContain(`href="${unsubscribe}"`);
		expect(mail.html).not.toMatch(/<img|<script/i);
		expect(mail.headers).toEqual({
			'List-Unsubscribe': `<${unsubscribe}>`,
			'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
		});
	});
});
