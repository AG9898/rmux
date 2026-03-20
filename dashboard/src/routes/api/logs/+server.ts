import { json } from '@sveltejs/kit';
import { getLogTail, listLogs } from '$lib/server/ralph';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const name = url.searchParams.get('name');
	const lines = parseInt(url.searchParams.get('lines') || '150');

	if (name) {
		const log = await getLogTail(name, lines);
		return json({ name, log });
	}

	const logs = await listLogs();
	return json({ logs });
};
