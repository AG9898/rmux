import { json } from '@sveltejs/kit';
import { killInstance, killAll } from '$lib/server/ralph';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const name: string = body.name;

	if (name === 'all') {
		const result = await killAll();
		return json({ success: true, ...result });
	}

	const result = await killInstance(name);
	return json(result);
};
