import { describe, expect, it } from 'vitest';
import { summarize, toSourceStatus, type SourceStatus } from '$lib/server/health';

const ok = { ok: true };
const src = (status: SourceStatus['status']): SourceStatus => ({
	source: 'arxiv',
	status,
	lastRunAt: null,
	lastSuccessAt: null
});

describe('summarize', () => {
	it('alles gesund → ok/200', () => {
		expect(
			summarize(ok, { ok: true, worker: { live: true, heartbeatOn: null } }, [
				src('ok'),
				src('never')
			])
		).toEqual({
			status: 'ok',
			httpStatus: 200
		});
	});

	it('Datenbank oder Queue nicht erreichbar → error/503', () => {
		expect(summarize({ ok: false, error: 'x' }, { ok: true }, [])).toEqual({
			status: 'error',
			httpStatus: 503
		});
		expect(summarize(ok, { ok: false, error: 'x' }, [])).toEqual({
			status: 'error',
			httpStatus: 503
		});
	});

	it('Quelle fehlgeschlagen oder Worker weg → degraded, aber 200', () => {
		expect(summarize(ok, { ok: true }, [src('ok'), src('error')])).toEqual({
			status: 'degraded',
			httpStatus: 200
		});
		expect(summarize(ok, { ok: true, worker: { live: false, heartbeatOn: null } }, [])).toEqual({
			status: 'degraded',
			httpStatus: 200
		});
	});
});

describe('toSourceStatus', () => {
	it('übernimmt Zeitpunkte und kürzt Fehlermeldungen; Fehler nur bei Status error', () => {
		const at = new Date('2026-11-03T06:00:00Z');
		expect(
			toSourceStatus({
				source: 'europepmc',
				lastRunAt: at,
				lastSuccessAt: null,
				lastStatus: 'error',
				lastError: 'x'.repeat(500)
			})
		).toEqual({
			source: 'europepmc',
			status: 'error',
			lastRunAt: '2026-11-03T06:00:00.000Z',
			lastSuccessAt: null,
			error: 'x'.repeat(200)
		});
		expect(
			toSourceStatus({
				source: 'arxiv',
				lastRunAt: null,
				lastSuccessAt: null,
				lastStatus: null,
				lastError: null
			})
		).toEqual({ source: 'arxiv', status: 'never', lastRunAt: null, lastSuccessAt: null });
		expect(
			toSourceStatus({
				source: 'arxiv',
				lastRunAt: at,
				lastSuccessAt: at,
				lastStatus: 'ok',
				lastError: 'alt'
			})
		).not.toHaveProperty('error');
	});
});
