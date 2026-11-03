import { describe, expect, it } from 'vitest';
import { explainReasons } from '$lib/ranking/reasons';
import {
	authorNameVariants,
	DEFAULT_RANKING,
	loadRankingConfig,
	normalizeTextRank,
	recencyDecay,
	scoreMatch,
	type SubscriptionHit
} from '$lib/server/ranking/score';

const NOW = new Date('2026-11-03T12:00:00Z');
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

const kw = (id: number, rank: number, weight = 1, inTitle = true): SubscriptionHit => ({
	subscriptionId: id,
	type: 'keyword',
	query: `kw${id}`,
	weight,
	textRank: rank,
	inTitle
});
const cat = (id: number, weight = 1): SubscriptionHit => ({
	subscriptionId: id,
	type: 'category',
	query: 'cs.DL',
	weight
});
const author = (id: number, weight = 1): SubscriptionHit => ({
	subscriptionId: id,
	type: 'author',
	query: 'Rui Yang',
	weight
});

describe('normalizeTextRank', () => {
	it('bildet [0, ∞) monoton auf [0, 1) ab', () => {
		expect(normalizeTextRank(0)).toBe(0);
		expect(normalizeTextRank(1)).toBe(0.5);
		expect(normalizeTextRank(3)).toBe(0.75);
		expect(normalizeTextRank(1e9)).toBeLessThan(1);
		expect(normalizeTextRank(0.2)).toBeLessThan(normalizeTextRank(0.3));
	});

	it('robust gegen ungültige Werte', () => {
		expect(normalizeTextRank(-1)).toBe(0);
		expect(normalizeTextRank(Number.NaN)).toBe(0);
		expect(normalizeTextRank(Number.POSITIVE_INFINITY)).toBe(0);
	});
});

describe('recencyDecay', () => {
	it('halbiert sich je Halbwertszeit', () => {
		expect(recencyDecay(NOW, NOW, 7)).toBe(1);
		expect(recencyDecay(daysAgo(7), NOW, 7)).toBeCloseTo(0.5);
		expect(recencyDecay(daysAgo(14), NOW, 7)).toBeCloseTo(0.25);
		expect(recencyDecay(daysAgo(3), NOW, 3)).toBeCloseTo(0.5);
	});

	it('Datum in der Zukunft zählt wie heute', () => {
		expect(recencyDecay(new Date(NOW.getTime() + 5 * DAY), NOW, 7)).toBe(1);
	});
});

describe('scoreMatch', () => {
	it('kein Treffer → null', () => {
		expect(scoreMatch([], NOW, NOW)).toBeNull();
	});

	it('Textrelevanz × Gewicht', () => {
		expect(scoreMatch([kw(1, 1)], NOW, NOW)?.score).toBeCloseTo(0.5);
		expect(scoreMatch([kw(1, 1, 2)], NOW, NOW)?.score).toBeCloseTo(1);
		expect(scoreMatch([kw(1, 1, 0.5)], NOW, NOW)?.score).toBeCloseTo(0.25);
	});

	it('Autor- und Kategorie-Boost addieren sich (mit Abo-Gewicht)', () => {
		const { authorBoost, categoryBoost } = DEFAULT_RANKING;
		expect(scoreMatch([author(1)], NOW, NOW)?.score).toBeCloseTo(authorBoost);
		expect(scoreMatch([cat(1, 2)], NOW, NOW)?.score).toBeCloseTo(categoryBoost * 2);
		expect(scoreMatch([kw(1, 1), author(2), cat(3)], NOW, NOW)?.score).toBeCloseTo(
			0.5 + authorBoost + categoryBoost
		);
	});

	it('Aktualitäts-Abfall wirkt auf den Score, nicht auf die Relevanz', () => {
		const fresh = scoreMatch([kw(1, 1), cat(2)], NOW, NOW);
		const old = scoreMatch([kw(1, 1), cat(2)], daysAgo(7), NOW);
		expect(old?.score).toBeCloseTo((fresh?.score ?? 0) / 2);
		expect(old?.relevance).toBe(fresh?.relevance);
	});

	it('mehrere Stichwort-Abos zählen nicht doppelt – das stärkste zählt', () => {
		const single = scoreMatch([kw(1, 3)], NOW, NOW);
		const both = scoreMatch([kw(1, 3), kw(2, 1)], NOW, NOW);
		expect(both?.score).toBe(single?.score);
		expect(both?.subscriptionIds).toEqual([1, 2]);
		expect(both?.reasons.map((r) => r.subscriptionId)).toEqual([1, 2]);
	});

	it('Duplikate desselben Abos werden zusammengefasst', () => {
		const result = scoreMatch([kw(1, 0.5), kw(1, 2), cat(2), cat(2)], NOW, NOW);
		expect(result?.subscriptionIds).toEqual([1, 2]);
		expect(result?.reasons).toHaveLength(2);
		expect(result?.reasons[0]?.contribution).toBeCloseTo(normalizeTextRank(2));
	});

	it('Begründungen sind nach Beitrag sortiert und enthalten die Titel-Info', () => {
		const result = scoreMatch([cat(5), kw(1, 3, 1, false), author(2)], NOW, NOW);
		expect(result?.reasons.map((r) => r.type)).toEqual(['keyword', 'author', 'category']);
		expect(result?.reasons[0]).toMatchObject({ inTitle: false, query: 'kw1' });
		expect(result?.reasons[1]).not.toHaveProperty('inTitle');
	});

	it('Treffer ohne Textrang (z. B. leerer Abstract) bleibt gültig', () => {
		const result = scoreMatch([kw(1, 0)], NOW, NOW);
		expect(result?.score).toBe(0);
		expect(result?.subscriptionIds).toEqual([1]);
	});
});

describe('authorNameVariants', () => {
	it('liefert volle Form und abgekürzte Vornamen', () => {
		expect(authorNameVariants('rui yang')).toEqual(['rui yang', 'r yang']);
		expect(authorNameVariants('juan martin maldacena')).toEqual([
			'juan martin maldacena',
			'j m maldacena',
			'j maldacena'
		]);
		expect(authorNameVariants('maldacena')).toEqual(['maldacena']);
		expect(authorNameVariants('')).toEqual([]);
	});
});

describe('explainReasons', () => {
	it('formuliert verständliche Gründe auf Deutsch', () => {
		const result = scoreMatch(
			[kw(1, 2, 2, true), cat(2), { ...author(3, 0.5), query: 'Jörg Müller' }],
			NOW,
			NOW
		);
		expect(explainReasons(result?.reasons ?? [])).toEqual([
			'Stichwort „kw1“ im Titel (höher gewichtet)',
			'arXiv-Kategorie cs.DL',
			'Autor:in Jörg Müller (niedriger gewichtet)'
		]);
	});
});

describe('loadRankingConfig', () => {
	it('liest die Halbwertszeit aus der Umgebung', () => {
		expect(loadRankingConfig({ RANKING_HALF_LIFE_DAYS: '14' }).halfLifeDays).toBe(14);
		expect(loadRankingConfig({ RANKING_HALF_LIFE_DAYS: 'x' }).halfLifeDays).toBe(7);
		expect(loadRankingConfig({ RANKING_HALF_LIFE_DAYS: '-1' }).halfLifeDays).toBe(7);
		expect(loadRankingConfig({}).halfLifeDays).toBe(7);
	});
});
