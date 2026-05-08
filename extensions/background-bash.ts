import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

type ActiveJob = {
	id: string;
	command: string;
	toolCallId: string;
	abortController: AbortController;
	startedAt: number;
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

function abortAllJobs() {
	shuttingDown = true;
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
				};
				activeJobs.set(job.id, job);
				pendingJobs.start({
					id: job.id,
					text: job.command,
					startedAt: job.startedAt,
					details: { toolCallId: job.toolCallId },
				});

				void runNativeBash(ctx.cwd, toolCallId, params, job.abortController.signal).then((completed) => {
					deliverBackgroundResult(pi, job, completed, ctx.cwd);
				});

				return {
					content: [{ type: "text", text: `Bash job ${job.id} started in background.` }],
					details: {
						jobId: job.id,
						command: job.command,
						outcome: "running",
						exitCode: null,
						toolCallId: job.toolCallId,
						startedAt: new Date(job.startedAt).toISOString(),
						cwd: ctx.cwd,
					},
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
				if (!backgrounded) onUpdate?.(update);
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
			activeJobs.set(job.id, job);
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
				content: [{ type: "text", text: `Bash job ${job.id} moved to background after ${formatThreshold(autoAfterSeconds)}.` }],
				details: {
					jobId: job.id,
					command: job.command,
					outcome: "running",
					exitCode: null,
					toolCallId: job.toolCallId,
					startedAt: new Date(job.startedAt).toISOString(),
					cwd: ctx.cwd,
				},
			};
		},
	});

}
