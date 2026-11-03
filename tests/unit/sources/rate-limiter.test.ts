import { describe, expect, it } from 'vitest';
import { RateLimiter, type RateLimiterEvent } from '$lib/server/sources/rate-limiter';
import { FakeClock } from './helpers';

function setup(opts: { minIntervalMs: number; maxConcurrent: number; spacing?: boolean }) {
	const clock = new FakeClock();
	const events: RateLimiterEvent[] = [];
	const limiter = new RateLimiter({
		name: 'test',
		minIntervalMs: opts.minIntervalMs,
		maxConcurrent: opts.maxConcurrent,
		spacingFromCompletion: opts.spacing ?? false,
		clock,
		onEvent: (e) => events.push(e)
	});
	return { clock, limiter, events };
}

const acquires = (events: RateLimiterEvent[]) =>
	events.filter((e) => e.type === 'acquire').map((e) => e.at);

describe('RateLimiter', () => {
	it('hält den Mindestabstand zwischen Starts ein (arXiv: 3 s)', async () => {
		const { limiter, events } = setup({ minIntervalMs: 3000, maxConcurrent: 1 });
		await Promise.all(Array.from({ length: 5 }, () => limiter.schedule(async () => 'ok')));
		const starts = acquires(events);
		expect(starts).toHaveLength(5);
		for (let i = 1; i < starts.length; i++) {
			expect((starts[i] as number) - (starts[i - 1] as number)).toBeGreaterThanOrEqual(3000);
		}
	});

	it('wartet mit spacingFromCompletion zusätzlich ab dem Ende des Vorgängers', async () => {
		const { clock, limiter, events } = setup({
			minIntervalMs: 3000,
			maxConcurrent: 1,
			spacing: true
		});
		// Jeder Request dauert 2 s.
		const task = () =>
			limiter.schedule(async () => {
				await clock.sleep(2000);
			});
		await Promise.all([task(), task(), task()]);
		const releases = events.filter((e) => e.type === 'release').map((e) => e.at);
		const starts = acquires(events);
		for (let i = 1; i < starts.length; i++) {
			expect((starts[i] as number) - (releases[i - 1] as number)).toBeGreaterThanOrEqual(3000);
		}
	});

	it('lässt nie mehr als maxConcurrent Aufgaben gleichzeitig laufen', async () => {
		const { limiter } = setup({ minIntervalMs: 0, maxConcurrent: 2 });
		let running = 0;
		let peak = 0;
		const gates: Array<() => void> = [];
		const tasks = Array.from({ length: 6 }, () =>
			limiter.schedule(async () => {
				running++;
				peak = Math.max(peak, running);
				await new Promise<void>((resolve) => gates.push(resolve));
				running--;
			})
		);
		// Aufgaben nacheinander freigeben, bis alle durch sind.
		for (let i = 0; i < 6; i++) {
			await new Promise((r) => setTimeout(r, 0));
			gates.shift()?.();
		}
		await Promise.all(tasks);
		expect(peak).toBe(2);
	});

	it('verarbeitet in FIFO-Reihenfolge und läuft nach Fehlern weiter', async () => {
		const { limiter } = setup({ minIntervalMs: 10, maxConcurrent: 1 });
		const order: number[] = [];
		const results = await Promise.allSettled([
			limiter.schedule(async () => order.push(1)),
			limiter.schedule(async () => {
				order.push(2);
				throw new Error('boom');
			}),
			limiter.schedule(async () => order.push(3))
		]);
		expect(order).toEqual([1, 2, 3]);
		expect(results[1]?.status).toBe('rejected');
		expect(results[2]?.status).toBe('fulfilled');
		expect(limiter.active).toBe(0);
	});

	it('pauseFor verschiebt den nächsten Start (Retry-After)', async () => {
		const { clock, limiter, events } = setup({ minIntervalMs: 100, maxConcurrent: 1 });
		await limiter.schedule(async () => undefined);
		limiter.pauseFor(30_000);
		await limiter.schedule(async () => undefined);
		const starts = acquires(events);
		expect((starts[1] as number) - (starts[0] as number)).toBeGreaterThanOrEqual(30_000);
		expect(events.some((e) => e.type === 'pause')).toBe(true);
		expect(clock.now()).toBeGreaterThanOrEqual(30_000);
	});

	it('update verschärft Limits, lockert sie aber nicht ohne allowLoosen', () => {
		const { limiter } = setup({ minIntervalMs: 200, maxConcurrent: 3 });
		limiter.update({ minIntervalMs: 1000, maxConcurrent: 1 });
		expect(limiter.minIntervalMs).toBe(1000);
		expect(limiter.maxConcurrent).toBe(1);
		limiter.update({ minIntervalMs: 100, maxConcurrent: 5 });
		expect(limiter.minIntervalMs).toBe(1000);
		expect(limiter.maxConcurrent).toBe(1);
		limiter.update({ minIntervalMs: 100, maxConcurrent: 5 }, true);
		expect(limiter.minIntervalMs).toBe(100);
		expect(limiter.maxConcurrent).toBe(5);
	});

	it('weist ungültige Optionen zurück', () => {
		expect(() => new RateLimiter({ name: 'x', minIntervalMs: -1, maxConcurrent: 1 })).toThrow();
		expect(() => new RateLimiter({ name: 'x', minIntervalMs: 0, maxConcurrent: 0 })).toThrow();
	});
});
