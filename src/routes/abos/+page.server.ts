import { error, fail } from '@sveltejs/kit';
import { getBoss, getDb } from '$lib/server/app';
import { requestBackfill } from '$lib/server/jobs/queues';
import {
	addSubscription,
	listSubscriptions,
	removeSubscription,
	SubscriptionError,
	updateSubscriptionWeight
} from '$lib/server/subscriptions';
import type { Actions, PageServerLoad } from './$types';

async function userId(locals: App.Locals): Promise<string> {
	const session = await locals.auth();
	if (!session?.user?.id) error(401, 'Nicht angemeldet');
	return session.user.id;
}

export const load: PageServerLoad = async ({ locals, depends }) => {
	depends('app:subscriptions');
	const subscriptions = await listSubscriptions(getDb(), await userId(locals));
	return { subscriptions };
};

export const actions: Actions = {
	add: async ({ locals, request }) => {
		const id = await userId(locals);
		const form = await request.formData();
		const values = {
			type: String(form.get('type') ?? ''),
			query: String(form.get('query') ?? ''),
			weight: String(form.get('weight') ?? '1')
		};
		try {
			const db = getDb();
			// Nutzeraktion → höchstens ein Job in der Queue, nie ein direkter Upstream-Aufruf.
			const result = await addSubscription(
				db,
				async (sourceQueryId) => requestBackfill(await getBoss(), db, sourceQueryId),
				id,
				values
			);
			return { added: true, backfillRequested: result.backfillRequested };
		} catch (e) {
			if (e instanceof SubscriptionError) return fail(400, { error: e.message, values });
			throw e;
		}
	},
	remove: async ({ locals, request }) => {
		const form = await request.formData();
		await removeSubscription(getDb(), await userId(locals), Number(form.get('id')));
		return { removed: true };
	},
	weight: async ({ locals, request }) => {
		const form = await request.formData();
		try {
			await updateSubscriptionWeight(
				getDb(),
				await userId(locals),
				Number(form.get('id')),
				form.get('weight')
			);
		} catch (e) {
			if (e instanceof SubscriptionError) return fail(400, { error: e.message });
			throw e;
		}
		return { updated: true };
	}
};
