import { json } from '@sveltejs/kit';
import { listInstances, cleanDead } from '$lib/server/ralph';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const instances = await listInstances();
	return json({ instances });
};

// POST to clean dead instances
export const POST: RequestHandler = async () => {
	const cleaned = await cleanDead();
	return json({ cleaned });
};
