import { feedResponse } from '$lib/server/feeds/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) => feedResponse(event, 'atom');
