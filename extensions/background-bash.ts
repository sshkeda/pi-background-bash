import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { BashToolDetails, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { createBashTool, createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
import { createPiPending } from "pi-pending";
import { piContext } from "pi-context";
import { Type } from "typebox";

const MAX_ACTIVE_JOBS = 10;
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

type ActiveJob = {
	id: string;
	command: string;
	toolCallId: string;
	abortController: AbortController;
	startedAt: number;
};

const schema = Type.Object({
	command: Type.String({ description: "Bash command to execute asynchronously" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
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
		name: "background_bash",
		label: "background_bash",
		description:
			"Execute a bash command asynchronously in the current working directory. Returns immediately with a job id. When the command finishes, a <pi_context source=\"pi-background-bash\" kind=\"background_bash_result\"> message is injected into the session using the same output/truncation style as Pi's bash tool. Use for long-running non-interactive commands; use bash when the next step depends immediately on the command output.",
		promptSnippet:
			"Execute long-running bash commands asynchronously; timeout is in seconds. Results arrive later as <pi_context source=\"pi-background-bash\" kind=\"background_bash_result\"> messages.",
		promptGuidelines: [
			"Use background_bash instead of bash for long-running non-interactive commands such as builds, full test suites, dev servers, watchers, deploys, downloads, or commands expected to take more than about 10 seconds.",
			"Use regular bash for quick commands or when the next step depends immediately on the command output.",
			"After calling background_bash, do not wait for its output in the same turn; continue with independent work or tell the user the background job started.",
			"When a <pi_context source=\"pi-background-bash\" kind=\"background_bash_result\"> message appears, treat its body like the result of a normal bash command and reference the id when reporting it.",
			"Do not use background_bash for interactive commands that require stdin.",
		],
		parameters: schema,
		renderCall(args, _theme, context) {
			return createBashToolDefinition(context.cwd).renderCall?.(args, _theme, context) ?? new Text("", 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = getText(result as AgentToolResult<unknown>);
			return new Text(`\n${theme.fg("toolOutput", text)}`, 0, 0);
		},
		async execute(toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<BackgroundBashDetails>> {
			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "Background bash job not started: tool call aborted." }],
					details: { jobId: "", command: params.command, outcome: "abort", exitCode: null },
				};
			}

			if (activeJobs.size >= MAX_ACTIVE_JOBS) {
				return {
					content: [
						{
							type: "text",
							text: `Too many background bash jobs running (${activeJobs.size}/${MAX_ACTIVE_JOBS}). Wait for one to finish before starting another.`,
						},
					],
					details: { jobId: "", command: params.command, outcome: "error", exitCode: null },
				};
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
				details: {
					toolCallId: job.toolCallId,
				},
			});

			// Intentionally delegates to Pi's built-in bash tool instead of reimplementing
			// output handling. This preserves native bash semantics: combined stdout/stderr,
			// tail truncation, full-output temp files, "(no output)", nonzero exit text, and
			// timeout text. If Pi bash changes, background_bash should inherit that behavior.
			// Source: @earendil-works/pi-coding-agent/dist/core/tools/bash.js
			const bashTool = createBashTool(ctx.cwd);

			void (async () => {
				let latestDetails: BashToolDetails | undefined;
				let body = "";
				let outcome: Outcome = "exit";
				let exitCode: number | null = 0;

				try {
					const result = await bashTool.execute(
						`background_bash:${job.id}`,
						params,
						job.abortController.signal,
						(update) => {
							latestDetails = update.details as BashToolDetails | undefined;
						},
					);
					body = getText(result);
					latestDetails = (result.details as BashToolDetails | undefined) ?? latestDetails;
					outcome = "exit";
					exitCode = 0;
				} catch (error) {
					body = error instanceof Error ? error.message : String(error);
					const detected = detectOutcomeAndExitCode(body);
					outcome = detected.outcome;
					exitCode = detected.exitCode;
				}

				activeJobs.delete(job.id);
				pendingJobs.finish(job.id);
				if (shuttingDown) return;

				const durationMs = Date.now() - job.startedAt;
				const content = buildXmlResult(job, outcome, exitCode, durationMs, body);
				const details: BackgroundBashDetails = {
					...(latestDetails ?? {}),
					jobId: job.id,
					command: job.command,
					outcome,
					exitCode,
					toolCallId: job.toolCallId,
					startedAt: new Date(job.startedAt).toISOString(),
					durationMs,
					body,
					cwd: ctx.cwd,
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
			})();

			return {
				content: [{ type: "text", text: `Background bash job ${job.id} started.` }],
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
