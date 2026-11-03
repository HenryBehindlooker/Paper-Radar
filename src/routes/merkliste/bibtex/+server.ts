import { getDb } from '$lib/server/app';
import { bibtexResponse } from '$lib/server/bibtex-export';
import { savedPapers } from '$lib/server/papers-view';
import { requireUserId } from '$lib/server/session';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	const userId = await requireUserId(locals);
	const { items } = await savedPapers(getDb(), userId, { size: Number.POSITIVE_INFINITY });
	return bibtexResponse(items, 'paper-radar-merkliste.bib');
};
