import { describe, expect, it } from 'vitest';
import { t } from './index';

describe('t()', () => {
	it('liefert deutsche Texte', () => {
		expect(t('app.name')).toBe('Paper-Radar');
	});

	it('lässt Texte ohne Platzhalter unverändert', () => {
		expect(t('nav.feed', { unused: 1 })).toBe('Feed');
	});
});
