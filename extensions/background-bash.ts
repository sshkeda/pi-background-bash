import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentToolUpdateCallback, BashToolDetails, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { createBashTool, createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
import { createPiPending } from "pi-pending";
import { piContext } from "pi-context";
import { Type } from "typebox";

const MAX_ACTIVE_JOBS = 10;
const DEFAULT_AUTO_BACKGROUND_AFTER_SECONDS = 30;
const CUSTOM_TYPE = "background_bash_result";

type Outcome = "running" | "exit" | "timeout" | "abort" | "error";

type BackgroundBashDetails = BashToolDetails & {
	jobId: string;
	command: string;
	outcome: Outcome;
	exitCode: number | null;
	toolCallId?: string;
	startedAt?: string;
	durationMs?: number;
	body?: string;
	cwd?: string;
	sessionId?: string;
	sessionKey?: string;
	instanceId?: string;
	lane?: string;
	globalJobId?: string;
	pbbCursor?: number;
};

type BashParams = {
	command: string;
	timeout?: number;
	background?: boolean;
};

type CompletedBashRun =
	| {
			status: "success";
			result: AgentToolResult<BashToolDetails>;
			body: string;
			details: BashToolDetails | undefined;
			outcome: "exit";
			exitCode: 0;
	  }
	| {
			status: "error";
			error: unknown;
			body: string;
			details: BashToolDetails | undefined;
			outcome: Outcome;
			exitCode: number | null;
	  };

type PbbIdentity = {
	sessionId?: string;
	sessionKey: string;
	sessionFile?: string;
	instanceId: string;
	lane?: string;
	laneRoot?: string;
	root: string;
};

type ActiveJob = {
	id: string;
	command: string;
	toolCallId: string;
	abortController: AbortController;
	startedAt: number;
	cwd?: string;
	pbb?: PbbIdentity;
	lastLoggedBody?: string;
	lastEventId?: number;
};

type BackgroundBashConfig = {
	autoBackgroundAfterSeconds?: number;
};

const schema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	background: Type.Optional(Type.Boolean({ description: "Run immediately in the background and return a job id" })),
});

const activeJobs = new Map<string, ActiveJob>();
const pendingJobs = createPiPending({
	namespace: "background-bash",
	format: (job) => `$ ${normalizeCommandForStatus(job.text)}`,
});
let nextJobNumber = 1;
let shuttingDown = false;
let processHooksInstalled = false;
let killRequestTimer: ReturnType<typeof setInterval> | undefined;

function normalizeCommandForStatus(command: string): string {
	return command.replace(/\s+/g, " ").trim();
}

function getText(result: AgentToolResult<unknown>): string {
	return result.content
		.map((part) => {
			if (part?.type === "text" && typeof part.text === "string") return part.text;
			try {
				return JSON.stringify(part);
			} catch {
				return String(part);
			}
		})
		.join("\n");
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function detectOutcomeAndExitCode(body: string): { outcome: Outcome; exitCode: number | null } {
	const exitMatch = body.match(/(?:^|\n)Command exited with code (\d+)$/);
	if (exitMatch) return { outcome: "exit", exitCode: Number(exitMatch[1]) };
	if (/(?:^|\n)Command timed out after [^\n]+ seconds$/.test(body)) return { outcome: "timeout", exitCode: null };
	if (/(?:^|\n)Command aborted$/.test(body)) return { outcome: "abort", exitCode: null };
	return { outcome: "error", exitCode: null };
}

function readConfigFile(path: string): BackgroundBashConfig {
	try {
		if (!existsSync(path)) return {};
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object") return {};
		const raw = (parsed as { autoBackgroundAfterSeconds?: unknown }).autoBackgroundAfterSeconds;
		return typeof raw === "number" && Number.isFinite(raw) ? { autoBackgroundAfterSeconds: raw } : {};
	} catch {
		return {};
	}
}

function getAutoBackgroundAfterSeconds(cwd?: string): number {
	const globalConfig = readConfigFile(join(homedir(), ".pi-background-bash", "config.json"));
	const projectConfig = cwd ? readConfigFile(join(cwd, ".pi", "background-bash.json")) : {};
	return projectConfig.autoBackgroundAfterSeconds ?? globalConfig.autoBackgroundAfterSeconds ?? DEFAULT_AUTO_BACKGROUND_AFTER_SECONDS;
}

function formatThreshold(seconds: number): string {
	return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

function stableSessionKey(sessionFile: string, sessionId?: string): string {
	return createHash("sha256").update(`${sessionId ?? "no-session-id"}\n${sessionFile}`).digest("hex").slice(0, 24);
}

const fallbackInstanceId = `pbb_${process.pid}_${randomUUID().slice(0, 8)}`;

function pbbIdentity(ctx: { sessionManager?: { getSessionId?: () => string | undefined; getSessionFile?: () => string | undefined } }): PbbIdentity | undefined {
	const sessionFile = process.env.PI_LANE_SESSION_FILE || ctx.sessionManager?.getSessionFile?.();
	const sessionId = process.env.PI_LANE_SESSION_ID || ctx.sessionManager?.getSessionId?.();
	const sessionKey = process.env.PI_LANE_SESSION_KEY || (sessionFile ? stableSessionKey(sessionFile, sessionId) : undefined);
	if (!sessionKey) return undefined;
	return {
		sessionId,
		sessionKey,
		sessionFile,
		instanceId: process.env.PI_LANE_INSTANCE_ID || fallbackInstanceId,
		lane: process.env.PI_LANE_CURRENT_LANE,
		laneRoot: process.env.PI_LANE_ROOT,
		root: process.env.PBB_ROOT || join(homedir(), ".pi", "pbb"),
	};
}

function pbbSessionDir(id: PbbIdentity): string {
	return join(id.root, "sessions", id.sessionKey);
}

function pbbInstanceDir(id: PbbIdentity): string {
	return join(pbbSessionDir(id), "instances", id.instanceId);
}

function exportPbbEnv(id: PbbIdentity): void {
	process.env.PBB_SESSION_KEY = id.sessionKey;
	process.env.PBB_INSTANCE_ID = id.instanceId;
	process.env.PBB_ROOT = id.root;
	if (id.sessionId) process.env.PBB_SESSION_ID = id.sessionId;
	if (id.sessionFile) process.env.PBB_SESSION_FILE = id.sessionFile;
	if (id.lane) process.env.PBB_LANE = id.lane;
}

function pbbJobsDir(id: PbbIdentity): string {
	return join(pbbInstanceDir(id), "jobs");
}

function pbbLogsDir(id: PbbIdentity): string {
	return join(pbbInstanceDir(id), "logs");
}

function pbbRequestsDir(id: PbbIdentity): string {
	return join(pbbInstanceDir(id), "requests");
}

function writeJsonFile(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(tmp, path);
}

function readPbbSeq(id: PbbIdentity): number {
	try {
		return Number(readFileSync(join(pbbInstanceDir(id), "seq"), "utf8")) || 0;
	} catch {
		return 0;
	}
}

function nextPbbEventId(id: PbbIdentity): number {
	const next = readPbbSeq(id) + 1;
	writeJsonFile(join(pbbInstanceDir(id), "identity.json"), {
		schemaVersion: 1,
		sessionId: id.sessionId,
		sessionKey: id.sessionKey,
		sessionFile: id.sessionFile,
		instanceId: id.instanceId,
		lane: id.lane,
		laneRoot: id.laneRoot,
		root: id.root,
		pid: process.pid,
		updatedAt: new Date().toISOString(),
	});
	mkdirSync(pbbInstanceDir(id), { recursive: true });
	writeFileSync(join(pbbInstanceDir(id), "seq"), String(next));
	return next;
}

function appendPbbEvent(job: ActiveJob, type: string, data: Record<string, unknown> = {}): number | undefined {
	if (!job.pbb) return undefined;
	const eventId = nextPbbEventId(job.pbb);
	job.lastEventId = eventId;
	mkdirSync(pbbInstanceDir(job.pbb), { recursive: true });
	appendFileSync(join(pbbInstanceDir(job.pbb), "events.jsonl"), `${JSON.stringify({
		schemaVersion: 1,
		eventId,
		type,
		at: new Date().toISOString(),
		sessionId: job.pbb.sessionId,
		sessionKey: job.pbb.sessionKey,
		instanceId: job.pbb.instanceId,
		lane: job.pbb.lane,
		jobId: job.id,
		globalJobId: `${job.pbb.instanceId}:${job.id}`,
		...data,
	})}\n`);
	return eventId;
}

function writePbbJob(job: ActiveJob, patch: Record<string, unknown> = {}): void {
	if (!job.pbb) return;
	mkdirSync(pbbJobsDir(job.pbb), { recursive: true });
	mkdirSync(pbbLogsDir(job.pbb), { recursive: true });
	writeJsonFile(join(pbbJobsDir(job.pbb), `${job.id}.json`), {
		schemaVersion: 1,
		jobId: job.id,
		globalJobId: `${job.pbb.instanceId}:${job.id}`,
		command: job.command,
		toolCallId: job.toolCallId,
		cwd: patch.cwd ?? job.cwd,
		status: "running",
		outcome: "running",
		exitCode: null,
		startedAt: new Date(job.startedAt).toISOString(),
		updatedAt: new Date().toISOString(),
		sessionId: job.pbb.sessionId,
		sessionKey: job.pbb.sessionKey,
		sessionFile: job.pbb.sessionFile,
		instanceId: job.pbb.instanceId,
		lane: job.pbb.lane,
		laneRoot: job.pbb.laneRoot,
		pid: process.pid,
		logPath: join(pbbLogsDir(job.pbb), `${job.id}.log`),
		lastEventId: job.lastEventId,
		...patch,
	});
}

function recordPbbJobStarted(job: ActiveJob, cwd: string): void {
	if (!job.pbb) return;
	job.cwd = cwd;
	appendPbbEvent(job, "job.started", { command: job.command, cwd });
	writePbbJob(job, { cwd, status: "running", outcome: "running" });
}

function appendPbbLogDelta(job: ActiveJob, body: string): void {
	if (!job.pbb || !body || body === job.lastLoggedBody) return;
	let delta = body;
	if (job.lastLoggedBody && body.startsWith(job.lastLoggedBody)) {
		delta = body.slice(job.lastLoggedBody.length);
	} else if (job.lastLoggedBody) {
		delta = `\n[pbb: output snapshot replaced]\n${body}`;
	}
	job.lastLoggedBody = body;
	if (!delta) return;
	mkdirSync(pbbLogsDir(job.pbb), { recursive: true });
	appendFileSync(join(pbbLogsDir(job.pbb), `${job.id}.log`), delta);
	appendPbbEvent(job, "job.output", { bytes: Buffer.byteLength(delta) });
	writePbbJob(job, { status: "running", outcome: "running", updatedAt: new Date().toISOString() });
}

function recordPbbJobCompleted(job: ActiveJob, completed: CompletedBashRun, cwd: string, durationMs: number): void {
	if (!job.pbb) return;
	appendPbbLogDelta(job, completed.body);
	appendPbbEvent(job, "job.completed", { outcome: completed.outcome, exitCode: completed.exitCode, durationMs });
	writePbbJob(job, {
		cwd,
		status: completed.outcome === "exit" ? "exited" : completed.outcome,
		outcome: completed.outcome,
		exitCode: completed.exitCode,
		completedAt: new Date().toISOString(),
		durationMs,
		lastEventId: job.lastEventId,
	});
}

function handlePbbKillRequests(): void {
	for (const job of activeJobs.values()) {
		if (!job.pbb) continue;
		const dir = pbbRequestsDir(job.pbb);
		if (!existsSync(dir)) continue;
		for (const item of readdirSync(dir)) {
			if (!item.endsWith(".json")) continue;
			const path = join(dir, item);
			let request: Record<string, unknown> | undefined;
			try {
				request = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			} catch {
				rmSync(path, { force: true });
				continue;
			}
			if (request.type !== "kill" || request.jobId !== job.id) continue;
			appendPbbEvent(job, "job.kill_requested", { requestId: request.requestId, signal: request.signal });
			writePbbJob(job, { status: "kill_requested", killRequestedAt: new Date().toISOString(), lastEventId: job.lastEventId });
			job.abortController.abort();
			rmSync(path, { force: true });
		}
	}
}

function waitForBackgroundThreshold(seconds: number): Promise<"background"> {
	return new Promise((resolve) => {
		const handle = setTimeout(() => resolve("background"), seconds * 1000);
		handle.unref?.();
	});
}

function rethrowBashError(completed: Extract<CompletedBashRun, { status: "error" }>): never {
	throw completed.error instanceof Error ? completed.error : new Error(String(completed.error));
}

async function runNativeBash(
	cwd: string,
	toolCallId: string,
	params: BashParams,
	signal: AbortSignal | undefined,
	onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
): Promise<CompletedBashRun> {
	const bashTool = createBashTool(cwd);
	let latestDetails: BashToolDetails | undefined;

	try {
		const result = (await bashTool.execute(toolCallId, params, signal, (update) => {
			latestDetails = update.details as BashToolDetails | undefined;
			onUpdate?.(update as AgentToolResult<BashToolDetails>);
		})) as AgentToolResult<BashToolDetails>;
		const body = getText(result);
		latestDetails = result.details ?? latestDetails;
		return { status: "success", result, body, details: latestDetails, outcome: "exit", exitCode: 0 };
	} catch (error) {
		const body = error instanceof Error ? error.message : String(error);
		const detected = detectOutcomeAndExitCode(body);
		return { status: "error", error, body, details: latestDetails, outcome: detected.outcome, exitCode: detected.exitCode };
	}
}

function buildXmlResult(job: ActiveJob, outcome: Outcome, exitCode: number | null, durationMs: number, body: string): string {
	// Raw body is intentional: it is exactly the text Pi's native bash tool produced.
	// pi-context only escapes closing wrapper tags so command output cannot
	// prematurely close the XML-ish context envelope.
	return piContext({
		source: "pi-background-bash",
		kind: "background_bash_result",
		id: job.id,
		attrs: {
			tool_call_id: job.toolCallId,
			session_id: job.pbb?.sessionId,
			session_key: job.pbb?.sessionKey,
			instance_id: job.pbb?.instanceId,
			lane: job.pbb?.lane,
			global_job_id: job.pbb ? `${job.pbb.instanceId}:${job.id}` : undefined,
			pbb_cursor: job.lastEventId,
			started_at: new Date(job.startedAt).toISOString(),
			command: job.command,
			outcome,
			exit_code: exitCode,
			duration_ms: durationMs,
		},
		body,
	});
}

function deliverBackgroundResult(pi: ExtensionAPI, job: ActiveJob, completed: CompletedBashRun, cwd: string) {
	activeJobs.delete(job.id);
	pendingJobs.finish(job.id);
	if (shuttingDown) return;

	const durationMs = Date.now() - job.startedAt;
	recordPbbJobCompleted(job, completed, cwd, durationMs);
	const content = buildXmlResult(job, completed.outcome, completed.exitCode, durationMs, completed.body);
	const details: BackgroundBashDetails = {
		...(completed.details ?? {}),
		jobId: job.id,
		command: job.command,
		outcome: completed.outcome,
		exitCode: completed.exitCode,
		toolCallId: job.toolCallId,
		startedAt: new Date(job.startedAt).toISOString(),
		durationMs,
		body: completed.body,
		cwd,
		...(job.pbb
			? {
					sessionId: job.pbb.sessionId,
					sessionKey: job.pbb.sessionKey,
					instanceId: job.pbb.instanceId,
					lane: job.pbb.lane,
					globalJobId: `${job.pbb.instanceId}:${job.id}`,
					pbbCursor: job.lastEventId,
				}
			: {}),
	};

	pi.sendMessage(
		{
			customType: CUSTOM_TYPE,
			content,
			display: true,
			details,
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
}

function stripBashInlineTruncationNotice(body: string, details: BackgroundBashDetails | undefined): string {
	// Pi's bash execute() includes a human-readable truncation suffix in the text
	// returned to the model, while Pi's native renderResult() also renders the
	// same information from details.truncation/fullOutputPath. For display, let
	// the native renderer own that metadata so background_bash does not show the
	// full-output path twice. Keep message.content/body unchanged for LLM context.
	if (!details?.fullOutputPath && !details?.truncation?.truncated) return body;
	return body.replace(
		/\n\n\[Showing (?:last [^\]\n]+ of line \d+ \(line is [^)]+\)|lines \d+-\d+ of \d+(?: \([^)]+ limit\))?)\. Full output: [^\]\n]+\](?=\n\nCommand (?:exited|timed out|aborted)|$)/,
		"",
	);
}

function renderNativeBashResult(command: string, body: string, details: BackgroundBashDetails | undefined, expanded: boolean, theme: any) {
	const cwd = details?.cwd ?? process.cwd();
	const bash = createBashToolDefinition(cwd);
	const state: any = {
		startedAt: details?.durationMs === undefined ? undefined : Date.now() - details.durationMs,
		endedAt: Date.now(),
		interval: undefined,
	};
	const isError = details?.outcome !== "exit" || (details.exitCode !== null && details.exitCode !== 0);
	const renderContext = (lastComponent: any) => ({
		args: { command },
		toolCallId: details?.jobId ?? "background_bash_result",
		invalidate: () => {},
		lastComponent,
		state,
		cwd,
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded,
		showImages: true,
		isError,
	});

	const box = new Box(1, 1, (text) => (isError ? theme.bg("toolErrorBg", text) : theme.bg("toolSuccessBg", text)));
	if (details?.jobId) {
		const status =
			details.outcome === "exit" && (details.exitCode === null || details.exitCode === 0)
				? "done"
				: details.outcome === "timeout"
					? "timed out"
					: details.outcome === "abort"
						? "aborted"
						: "failed";
		box.addChild(new Text(theme.fg("muted", `↳ ${details.jobId} ${status}.`), 0, 0));
	}
	const call = bash.renderCall?.({ command }, theme, renderContext(undefined));
	if (call) box.addChild(call);
	const result = bash.renderResult?.(
		{ content: [{ type: "text", text: stripBashInlineTruncationNotice(body, details) }], details },
		{ expanded, isPartial: false },
		theme,
		renderContext(undefined),
	);
	if (result) box.addChild(result);

	const container = new Container();
	container.addChild(box);
	return container;
}

function runningJobDetails(job: ActiveJob, cwd: string): BackgroundBashDetails {
	return {
		jobId: job.id,
		command: job.command,
		outcome: "running",
		exitCode: null,
		toolCallId: job.toolCallId,
		startedAt: new Date(job.startedAt).toISOString(),
		cwd,
		...(job.pbb
			? {
					sessionId: job.pbb.sessionId,
					sessionKey: job.pbb.sessionKey,
					instanceId: job.pbb.instanceId,
					lane: job.pbb.lane,
					globalJobId: `${job.pbb.instanceId}:${job.id}`,
					pbbCursor: job.lastEventId,
				}
			: {}),
	};
}

function abortAllJobs() {
	shuttingDown = true;
	if (killRequestTimer) clearInterval(killRequestTimer);
	killRequestTimer = undefined;
	for (const job of activeJobs.values()) {
		job.abortController.abort();
	}
	activeJobs.clear();
	pendingJobs.clear();
}

function installProcessHooks() {
	if (processHooksInstalled) return;
	processHooksInstalled = true;
	// Best-effort last resort. Normal cleanup happens on Pi's session_shutdown event;
	// do not install SIGINT/SIGTERM handlers here because that would interfere with
	// Pi's own process-level signal handling.
	process.once("exit", abortAllJobs);
}

function restoreJobCounterFromSession(ctx: { sessionManager?: { getEntries?: () => unknown[] } }) {
	let max = 0;
	const entries = ctx.sessionManager?.getEntries?.() ?? [];
	for (const entry of entries as Array<Record<string, unknown>>) {
		const details = entry.details as Record<string, unknown> | undefined;
		const content = typeof entry.content === "string" ? entry.content : undefined;
		const candidates = [details?.jobId, content?.match(/<pi_context\b[^>]*\bid="bg_(\d+)"/)?.[1], content?.match(/Background bash job bg_(\d+)/)?.[1]];
		for (const candidate of candidates) {
			if (typeof candidate !== "string") continue;
			const match = candidate.match(/^bg_(\d+)$/) ?? candidate.match(/^(\d+)$/);
			if (match) max = Math.max(max, Number(match[1]));
		}
	}
	nextJobNumber = Math.max(nextJobNumber, max + 1);
}

export default function backgroundBashExtension(pi: ExtensionAPI) {
	installProcessHooks();

	pi.registerMessageRenderer<BackgroundBashDetails>(CUSTOM_TYPE, (message, options, theme) => {
		const details = message.details;
		const command = details?.command ?? "";
		const body = details?.body ?? (typeof message.content === "string" ? message.content : "");
		return renderNativeBashResult(command, body, details, options.expanded, theme);
	});

	pi.on("session_start", async (_event, ctx) => {
		shuttingDown = false;
		const id = pbbIdentity(ctx);
		if (id) exportPbbEnv(id);
		if (killRequestTimer) clearInterval(killRequestTimer);
		killRequestTimer = setInterval(handlePbbKillRequests, 250);
		killRequestTimer.unref?.();
		if (ctx.hasUI) pendingJobs.attach(ctx.ui);
		restoreJobCounterFromSession(ctx);
	});

	pi.on("session_shutdown", async () => {
		abortAllJobs();
		pendingJobs.detach();
	});

	pi.registerTool({
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated using Pi's native bash limits. Set background: true to run immediately in the background and get a job id. Otherwise, if the command is still running after the configured auto-background threshold (${formatThreshold(DEFAULT_AUTO_BACKGROUND_AFTER_SECONDS)} by default), it is automatically moved to the background; a <pi_context source="pi-background-bash" kind="background_bash_result"> message is injected when it finishes. Optionally provide a timeout in seconds.`,
		promptSnippet: `Execute bash commands (ls, grep, find, etc.); timeout is in seconds. Set background: true for long-running non-interactive commands. Commands still running after the configured auto-background threshold (${formatThreshold(DEFAULT_AUTO_BACKGROUND_AFTER_SECONDS)} by default) automatically move to background and wake you with a pi-background-bash result when finished.`,
		promptGuidelines: [
			"Use bash with background: true for long-running non-interactive commands such as builds, full test suites, dev servers, watchers, deploys, downloads, or commands you do not need before the next step.",
			`Use bash normally for shell commands; Pi automatically moves bash commands that run longer than the configured auto-background threshold (${formatThreshold(DEFAULT_AUTO_BACKGROUND_AFTER_SECONDS)} by default) to the background.`,
			"When bash reports that a command started or moved to background, do not retry it just to wait; continue independent work or tell the user the job is running.",
			"Use the pbb CLI (`pbb list`, `pbb status <job>`, `pbb tail <job>`) to inspect current-session background bash jobs; pbb defaults to the current pi-lane runtime instance when available.",
			"When a <pi_context source=\"pi-background-bash\" kind=\"background_bash_result\"> message appears, treat it like the final result of the original bash command.",
			"Do not use bash for interactive commands that require stdin unless the user explicitly asks for that behavior.",
		],
		parameters: schema,
		async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<BashToolDetails | BackgroundBashDetails>> {
			const autoAfterSeconds = getAutoBackgroundAfterSeconds(ctx.cwd);

			if (signal?.aborted) {
				throw new Error("Command aborted");
			}

			if (params.background) {
				if (activeJobs.size >= MAX_ACTIVE_JOBS) {
					throw new Error(`Too many bash jobs running (${activeJobs.size}/${MAX_ACTIVE_JOBS}). Wait for one to finish before starting another.`);
				}

				const job: ActiveJob = {
					id: `bg_${nextJobNumber++}`,
					command: params.command,
					toolCallId,
					abortController: new AbortController(),
					startedAt: Date.now(),
					cwd: ctx.cwd,
					pbb: pbbIdentity(ctx),
				};
				activeJobs.set(job.id, job);
				recordPbbJobStarted(job, ctx.cwd);
				pendingJobs.start({
					id: job.id,
					text: job.command,
					startedAt: job.startedAt,
					details: { toolCallId: job.toolCallId },
				});

				void runNativeBash(ctx.cwd, toolCallId, params, job.abortController.signal, (update) => {
					appendPbbLogDelta(job, getText(update));
				}).then((completed) => {
					deliverBackgroundResult(pi, job, completed, ctx.cwd);
				});

				return {
					content: [{ type: "text", text: `Bash job ${job.id} started in background. Use pbb status ${job.id} or pbb tail ${job.id} to inspect it.` }],
					details: runningJobDetails(job, ctx.cwd),
				};
			}

			if (autoAfterSeconds <= 0) {
				const completed = await runNativeBash(ctx.cwd, toolCallId, params, signal, onUpdate);
				if (completed.status === "success") return completed.result;
				rethrowBashError(completed);
			}

			if (activeJobs.size >= MAX_ACTIVE_JOBS) {
				throw new Error(`Too many bash jobs running (${activeJobs.size}/${MAX_ACTIVE_JOBS}). Wait for one to finish before starting another.`);
			}

			const job: ActiveJob = {
				// Foreground bash calls should not consume visible bg_N ids unless they
				// actually cross the threshold and become background jobs.
				id: `auto_${toolCallId}`,
				command: params.command,
				toolCallId,
				abortController: new AbortController(),
				startedAt: Date.now(),
			};
			activeJobs.set(job.id, job);

			let backgrounded = false;
			const forwardAbort = () => {
				if (!backgrounded) job.abortController.abort();
			};
			if (signal?.aborted) forwardAbort();
			else signal?.addEventListener("abort", forwardAbort, { once: true });

			const completedPromise = runNativeBash(ctx.cwd, toolCallId, params, job.abortController.signal, (update) => {
				if (backgrounded) appendPbbLogDelta(job, getText(update));
				else onUpdate?.(update);
			});

			const winner = await Promise.race([completedPromise, waitForBackgroundThreshold(autoAfterSeconds)]);
			if (winner !== "background") {
				signal?.removeEventListener("abort", forwardAbort);
				activeJobs.delete(job.id);
				if (winner.status === "success") return winner.result;
				rethrowBashError(winner);
			}

			backgrounded = true;
			signal?.removeEventListener("abort", forwardAbort);
			activeJobs.delete(job.id);
			job.id = `bg_${nextJobNumber++}`;
			job.cwd = ctx.cwd;
			job.pbb = pbbIdentity(ctx);
			activeJobs.set(job.id, job);
			recordPbbJobStarted(job, ctx.cwd);
			pendingJobs.start({
				id: job.id,
				text: job.command,
				startedAt: job.startedAt,
				details: { toolCallId: job.toolCallId },
			});

			void completedPromise.then((completed) => {
				deliverBackgroundResult(pi, job, completed, ctx.cwd);
			});

			return {
				content: [{ type: "text", text: `Bash job ${job.id} moved to background after ${formatThreshold(autoAfterSeconds)}. Use pbb status ${job.id} or pbb tail ${job.id} to inspect it.` }],
				details: runningJobDetails(job, ctx.cwd),
			};
		},
	});

}
