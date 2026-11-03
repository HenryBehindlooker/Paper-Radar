import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/app';
import { bibtexResponse } from '$lib/server/bibtex-export';
import { paperDetail } from '$lib/server/papers-view';
import { requireUserId } from '$lib/server/session';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	const userId = await requireUserId(locals);
	const id = Number(params.id);
	const paper = Number.isSafeInteger(id) ? await paperDetail(getDb(), userId, id) : null;
	if (!paper) error(404, 'Paper nicht gefunden');
	return bibtexResponse([paper], `paper-radar-${id}.bib`);
};
