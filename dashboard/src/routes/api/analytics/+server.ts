import { json } from '@sveltejs/kit';
import { getAnalytics } from '$lib/server/ralph';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const analytics = await getAnalytics();
	return json(analytics);
};
