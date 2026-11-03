import { appKeys, getDb } from '$lib/server/app';
import { unsubscribeByToken } from '$lib/server/digest';
import { verifyToken } from '$lib/server/tokens';
import type { Actions, PageServerLoad } from './$types';

/** GET ändert nichts (Link-Scanner in Postfächern öffnen Links automatisch). */
export const load: PageServerLoad = async ({ params }) => {
	return { valid: verifyToken(appKeys().unsubscribe, params.token) !== null };
};

export const actions: Actions = {
	/** Bestätigungs-Button und Ein-Klick-Abmeldung (RFC 8058) landen hier. */
	default: async ({ params }) => {
		const done = await unsubscribeByToken(getDb(), appKeys().unsubscribe, params.token);
		return { done };
	}
};
