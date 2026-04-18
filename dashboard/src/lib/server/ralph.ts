import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';

const execAsync = promisify(exec);

const RALPH_DIR = join(homedir(), '.ralph');
const PID_DIR = join(RALPH_DIR, 'pids');
const LOG_DIR = join(RALPH_DIR, 'logs');
async function findRalphBin(): Promise<string> {
	if (process.env.RALPH_BIN) return process.env.RALPH_BIN;
	try {
		const { stdout } = await execAsync('which ralph');
		const p = stdout.trim();
		if (p) return p;
	} catch { /* not in PATH */ }
	return 'ralph';
}

export interface RalphInstance {
	name: string;
	pid: number;
	prompt: string;
	maxRuns: number;
	model: string;
	workDir: string;
	workDirAbs: string;
	taskqFile: string;
	taskqBoardFormat: string;
	presetName: string;
	marathon: boolean;
	started: string;
	currentRun: number;
	alive: boolean;
	logFile: string;
	logSize: number;
}

export interface RalphLog {
	name: string;
	path: string;
	size: number;
	modified: string;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function isProcessAlive(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function signalPath(name: string): string {
	return join(PID_DIR, `${name}.signal`);
}

function parseMeta(content: string): Record<string, string> {
	const meta: Record<string, string> = {};
	for (const line of content.split('\n')) {
		const eq = line.indexOf('=');
		if (eq > 0) {
			meta[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
		}
	}
	return meta;
}

function decodePromptB64(value: string): string | null {
	const compact = value.replace(/\s+/g, '');
	if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
		return null;
	}

	try {
		const decoded = Buffer.from(compact, 'base64').toString('utf-8');
		const normalized = Buffer.from(decoded, 'utf-8').toString('base64').replace(/=+$/u, '');
		if (normalized !== compact.replace(/=+$/u, '')) {
			return null;
		}
		return decoded;
	} catch {
		return null;
	}
}

export async function listInstances(): Promise<RalphInstance[]> {
	const instances: RalphInstance[] = [];
	const knownNames = new Set<string>();

	// 1. Active instances from meta files
	if (await fileExists(PID_DIR)) {
		const files = await readdir(PID_DIR);
		const metaFiles = files.filter((f) => f.endsWith('.meta'));

		for (const file of metaFiles) {
			try {
				const content = await readFile(join(PID_DIR, file), 'utf-8');
				const meta = parseMeta(content);
				const pid = parseInt(meta.pid || '0');
				const name = meta.name || file.replace('.meta', '');
				knownNames.add(name);
				const logFile = join(LOG_DIR, `${name}.log`);
				let logSize = 0;
				try {
					const s = await stat(logFile);
					logSize = s.size;
				} catch { /* no log yet */ }

				instances.push({
					name,
					pid,
					prompt: decodePromptB64(meta.prompt_b64) || meta.prompt || '',
					maxRuns: parseInt(meta.max_runs || '0'),
					model: meta.model || 'opus',
					workDir: meta.work_dir || '',
					workDirAbs: meta.work_dir_abs || '',
					taskqFile: meta.taskq_file || '',
					taskqBoardFormat: meta.taskq_board_format || '',
					presetName: meta.preset_name || '',
					marathon: meta.marathon === 'true',
					started: meta.started || '',
					currentRun: parseInt(meta.current_run || '0'),
					alive: await isProcessAlive(pid),
					logFile,
					logSize
				});
			} catch { /* skip corrupt meta */ }
		}
	}

	// 2. Discover orphan logs (finished ralphs with no meta)
	if (await fileExists(LOG_DIR)) {
		const logFiles = await readdir(LOG_DIR);
		for (const file of logFiles.filter((f) => f.endsWith('.log'))) {
			const name = file.replace('.log', '');
			if (knownNames.has(name)) continue;

			try {
				const logFile = join(LOG_DIR, file);
				const s = await stat(logFile);
				instances.push({
					name,
					pid: 0,
					prompt: '(finished — check log)',
					maxRuns: 0,
					model: '?',
					workDir: '',
					workDirAbs: '',
					taskqFile: '',
					taskqBoardFormat: '',
					presetName: '',
					marathon: false,
					started: s.mtime.toISOString(),
					currentRun: 0,
					alive: false,
					logFile,
					logSize: s.size
				});
			} catch { /* skip */ }
		}
	}

	return instances.sort((a, b) => b.started.localeCompare(a.started));
}

export async function getLogTail(name: string, lines: number = 100): Promise<string> {
	const logFile = join(LOG_DIR, `${name}.log`);
	if (!(await fileExists(logFile))) return '';

	try {
		const { stdout } = await execAsync(`tail -n ${lines} ${JSON.stringify(logFile)}`);
		return stdout;
	} catch {
		return '';
	}
}

export async function getFullLog(name: string): Promise<string> {
	const logFile = join(LOG_DIR, `${name}.log`);
	if (!(await fileExists(logFile))) return '';
	return readFile(logFile, 'utf-8');
}

export async function listLogs(): Promise<RalphLog[]> {
	if (!(await fileExists(LOG_DIR))) return [];

	const files = await readdir(LOG_DIR);
	const logs: RalphLog[] = [];

	for (const file of files.filter((f) => f.endsWith('.log'))) {
		try {
			const path = join(LOG_DIR, file);
			const s = await stat(path);
			logs.push({
				name: file.replace('.log', ''),
				path,
				size: s.size,
				modified: s.mtime.toISOString()
			});
		} catch { /* skip */ }
	}

	return logs.sort((a, b) => b.modified.localeCompare(a.modified));
}

export async function killInstance(name: string): Promise<{ success: boolean; message: string }> {
	const metaFile = join(PID_DIR, `${name}.meta`);
	if (!(await fileExists(metaFile))) {
		return { success: false, message: `No ralph named '${name}' found` };
	}

	const content = await readFile(metaFile, 'utf-8');
	const meta = parseMeta(content);
	const pid = parseInt(meta.pid || '0');

	if (!(await isProcessAlive(pid))) {
		// Clean up stale files
		await cleanMeta(name);
		return { success: true, message: `${name} was already dead (cleaned up)` };
	}

	try {
		// Kill process group
		process.kill(-pid, 'SIGTERM');
	} catch { /* ignore */ }
	try {
		process.kill(pid, 'SIGTERM');
	} catch { /* ignore */ }

	return { success: true, message: `Killed ${name} (PID ${pid})` };
}

export async function killAll(): Promise<{ killed: string[]; alreadyDead: string[] }> {
	const instances = await listInstances();
	const killed: string[] = [];
	const alreadyDead: string[] = [];

	for (const inst of instances) {
		if (inst.alive) {
			await killInstance(inst.name);
			killed.push(inst.name);
		} else {
			await cleanMeta(inst.name);
			alreadyDead.push(inst.name);
		}
	}

	return { killed, alreadyDead };
}

async function cleanMeta(name: string) {
	try { await readFile(join(PID_DIR, `${name}.meta`)); } catch { return; }
	const { unlink } = await import('node:fs/promises');
	try { await unlink(join(PID_DIR, `${name}.meta`)); } catch { /* ok */ }
	try { await unlink(join(PID_DIR, `${name}.pid`)); } catch { /* ok */ }
	try { await unlink(signalPath(name)); } catch { /* ok */ }
}

export async function cleanDead(): Promise<string[]> {
	const instances = await listInstances();
	const cleaned: string[] = [];

	for (const inst of instances) {
		if (!inst.alive) {
			await cleanMeta(inst.name);
			cleaned.push(inst.name);
		}
	}

	return cleaned;
}

export async function injectPrompt(name: string, prompt: string): Promise<{ success: boolean; message: string }> {
	const instanceName = name.trim();
	const message = prompt.trim();

	if (!instanceName) {
		return { success: false, message: 'instance name cannot be empty' };
	}
	if (!message) {
		return { success: false, message: 'prompt injection cannot be empty' };
	}

	const metaFile = join(PID_DIR, `${instanceName}.meta`);
	if (!(await fileExists(metaFile))) {
		return { success: false, message: `No ralph named '${instanceName}' found` };
	}

	const content = await readFile(metaFile, 'utf-8');
	const meta = parseMeta(content);
	const pid = parseInt(meta.pid || '0');
	if (!(await isProcessAlive(pid))) {
		return { success: false, message: `${instanceName} is not running` };
	}

	try {
		await writeFile(signalPath(instanceName), message, { flag: 'wx' });
		return { success: true, message: `Queued prompt injection for ${instanceName}` };
	} catch (err) {
		if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
			return {
				success: false,
				message: 'prompt injection already queued; wait for ralph to consume it'
			};
		}
		throw err;
	}
}

export interface SpawnOptions {
	prompt?: string;
	maxRuns?: number;
	name?: string;
	dir?: string;
	model?: string;
	marathon?: boolean;
}

export interface SessionSummary {
	name: string;
	model: string;
	cli: string;
	dir: string;
	taskqFile: string;
	taskqBoardFormat: string;
	presetName: string;
	started: string;
	ended: string | null;
	maxRuns: number;
	totalRuns: number;
	totalDurationS: number;
	rateLimitedCount: number;
	toolCallCount: number;
	taskqCyclesPassed: number;
	taskqCyclesFailed: number;
}

export interface AnalyticsResult {
	sessions: SessionSummary[];
	totals: {
		sessions: number;
		runs: number;
		durationS: number;
		rateLimited: number;
		toolCalls: number;
		taskqCyclesPassed: number;
		taskqCyclesFailed: number;
	};
	byModel: Record<string, { sessions: number; runs: number; durationS: number }>;
	toolCallFrequency: Record<string, number>;
}

const TOOL_LINE_RE = /^🔧\s+([^:]+):/u;
const EMPTY_ANALYTICS_TOTALS: AnalyticsResult['totals'] = {
	sessions: 0,
	runs: 0,
	durationS: 0,
	rateLimited: 0,
	toolCalls: 0,
	taskqCyclesPassed: 0,
	taskqCyclesFailed: 0
};

async function summarizeAnalyticsFile(
	filePath: string,
	fallbackName: string,
	toolCallFrequency: Record<string, number>
): Promise<SessionSummary | null> {
	const summary: SessionSummary = {
		name: fallbackName,
		model: '?',
		cli: 'claude',
		dir: '',
		taskqFile: '',
		taskqBoardFormat: '',
		presetName: '',
		started: '',
		ended: null,
		maxRuns: 0,
		totalRuns: 0,
		totalDurationS: 0,
		rateLimitedCount: 0,
		toolCallCount: 0,
		taskqCyclesPassed: 0,
		taskqCyclesFailed: 0
	};
	let hasMeaningfulData = false;

	const input = createReadStream(filePath, { encoding: 'utf8' });
	const lines = createInterface({ input, crlfDelay: Infinity });

	try {
		for await (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			let ev: Record<string, unknown>;
			try {
				ev = JSON.parse(trimmed);
			} catch {
				continue;
			}

			switch (ev.event) {
				case 'session_start':
					hasMeaningfulData = true;
					summary.name = (ev.name as string) || summary.name;
					summary.model = (ev.model as string) || '?';
					summary.cli = (ev.cli as string) || 'claude';
					summary.dir = (ev.dir as string) || '';
					summary.taskqFile = (ev.taskq_file as string) || '';
					summary.taskqBoardFormat = (ev.taskq_board_format as string) || '';
					summary.presetName = (ev.preset_name as string) || '';
					summary.started = (ev.ts as string) || '';
					summary.maxRuns = (ev.max_runs as number) || 0;
					break;
				case 'session_stop':
					hasMeaningfulData = true;
					summary.ended = (ev.ts as string) || null;
					summary.totalRuns = (ev.run_count as number) || summary.totalRuns;
					break;
				case 'run_complete':
					hasMeaningfulData = true;
					summary.totalRuns = Math.max(summary.totalRuns, (ev.run as number) || 0);
					summary.totalDurationS += (ev.duration_s as number) || 0;
					break;
				case 'rate_limited':
					hasMeaningfulData = true;
					summary.rateLimitedCount += 1;
					break;
				case 'output_line': {
					const text = (ev.text as string) || '';
					const m = TOOL_LINE_RE.exec(text);
					if (m) {
						hasMeaningfulData = true;
						const toolName = m[1].trim();
						summary.toolCallCount += 1;
						toolCallFrequency[toolName] = (toolCallFrequency[toolName] || 0) + 1;
					}
					break;
				}
				case 'taskq_cycle_result':
					hasMeaningfulData = true;
					if (ev.passed) summary.taskqCyclesPassed += 1;
					else summary.taskqCyclesFailed += 1;
					break;
			}
		}
	} finally {
		lines.close();
		input.destroy();
	}

	return hasMeaningfulData ? summary : null;
}

export async function getAnalytics(): Promise<AnalyticsResult> {
	const sessions: SessionSummary[] = [];
	const byModel: AnalyticsResult['byModel'] = {};
	const toolCallFrequency: Record<string, number> = {};

	if (!(await fileExists(LOG_DIR))) {
		return { sessions, totals: EMPTY_ANALYTICS_TOTALS, byModel, toolCallFrequency };
	}

	const files = await readdir(LOG_DIR);
	const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));

	for (const file of jsonlFiles) {
		const filePath = join(LOG_DIR, file);
		let summary: SessionSummary | null = null;
		try {
			summary = await summarizeAnalyticsFile(filePath, file.replace('.jsonl', ''), toolCallFrequency);
		} catch {
			continue;
		}
		if (summary) sessions.push(summary);

		if (!summary) continue;

		const m = summary.model;
		if (!byModel[m]) byModel[m] = { sessions: 0, runs: 0, durationS: 0 };
		byModel[m].sessions += 1;
		byModel[m].runs += summary.totalRuns;
		byModel[m].durationS += summary.totalDurationS;
	}

	sessions.sort((a, b) => b.started.localeCompare(a.started));

	const totals = sessions.reduce(
		(acc, s) => ({
			sessions: acc.sessions + 1,
			runs: acc.runs + s.totalRuns,
			durationS: acc.durationS + s.totalDurationS,
			rateLimited: acc.rateLimited + s.rateLimitedCount,
			toolCalls: acc.toolCalls + s.toolCallCount,
			taskqCyclesPassed: acc.taskqCyclesPassed + s.taskqCyclesPassed,
			taskqCyclesFailed: acc.taskqCyclesFailed + s.taskqCyclesFailed
		}),
		EMPTY_ANALYTICS_TOTALS
	);

	return { sessions, totals, byModel, toolCallFrequency };
}

export async function spawnRalph(opts: SpawnOptions): Promise<{ name: string; pid: number }> {
	const RALPH_BIN = await findRalphBin();
	const args: string[] = [];

	if (opts.prompt) {
		args.push(opts.prompt);
	}
	if (opts.maxRuns && opts.maxRuns > 0) {
		args.push(String(opts.maxRuns));
	}
	if (opts.name) {
		args.push('-n', opts.name);
	}
	if (opts.dir) {
		args.push('-d', opts.dir);
	}
	if (opts.model) {
		args.push('-m', opts.model);
	}
	if (opts.marathon) {
		args.push('--marathon');
	}

	const child = spawn(RALPH_BIN, args, {
		detached: true,
		stdio: 'ignore',
		cwd: opts.dir || homedir(),
		shell: true
	});

	child.unref();
	const pid = child.pid || 0;
	const name = opts.name || `ralph-spawned-${pid}`;

	return { name, pid };
}
