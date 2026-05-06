import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { BashToolDetails, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const MAX_ACTIVE_JOBS = 10;
const CUSTOM_TYPE = "background_bash_result";

type Outcome = "running" | "exit" | "timeout" | "abort" | "error";

type BackgroundBashDetails = BashToolDetails & {
	jobId: string;
	command: string;
	outcome: Outcome;
	exitCode: number | null;
	durationMs?: number;
};

type ActiveJob = {
	id: string;
	command: string;
	abortController: AbortController;
	startedAt: number;
};

const schema = Type.Object({
	command: Type.String({ description: "Bash command to execute asynchronously" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

const activeJobs = new Map<string, ActiveJob>();
let nextJobNumber = 1;
let shuttingDown = false;
let processHooksInstalled = false;

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

function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\r/g, "&#13;")
		.replace(/\n/g, "&#10;");
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
	const attrs = [
		`job_id="${escapeXmlAttribute(job.id)}"`,
		`command="${escapeXmlAttribute(job.command)}"`,
		`outcome="${escapeXmlAttribute(outcome)}"`,
	];
	if (exitCode !== null) attrs.push(`exit_code="${exitCode}"`);
	attrs.push(`duration_ms="${durationMs}"`);

	// Raw body is intentional: it is exactly the text Pi's native bash tool produced.
	// Pi itself uses XML-ish context wrappers (e.g. <summary>, <provider_tool>) for LLM
	// semantics, not strict XML parsing; escaping bash output would break native parity.
	return `<background_bash_result ${attrs.join(" ")}>\n${body}\n</background_bash_result>`;
}

function abortAllJobs() {
	shuttingDown = true;
	for (const job of activeJobs.values()) {
		job.abortController.abort();
	}
	activeJobs.clear();
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
		const candidates = [details?.jobId, content?.match(/job_id="bg_(\d+)"/)?.[1], content?.match(/Background bash job bg_(\d+)/)?.[1]];
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

	pi.on("session_start", async (_event, ctx) => {
		shuttingDown = false;
		restoreJobCounterFromSession(ctx);
	});

	pi.on("session_shutdown", async () => {
		abortAllJobs();
	});

	pi.registerTool({
		name: "background_bash",
		label: "background_bash",
		description:
			"Execute a bash command asynchronously in the current working directory. Returns immediately with a job id. When the command finishes, a <background_bash_result> message is injected into the session using the same output/truncation style as Pi's bash tool. Use for long-running non-interactive commands; use bash when the next step depends immediately on the output.",
		promptSnippet:
			"Execute long-running bash commands asynchronously; timeout is in seconds. Results arrive later as <background_bash_result> messages.",
		promptGuidelines: [
			"Use background_bash instead of bash for long-running non-interactive commands such as builds, full test suites, dev servers, watchers, deploys, downloads, or commands expected to take more than about 10 seconds.",
			"Use regular bash for quick commands or when the next step depends immediately on the command output.",
			"After calling background_bash, do not wait for its output in the same turn; continue with independent work or tell the user the background job started.",
			"When a <background_bash_result> message appears, treat its body like the result of a normal bash command and reference the job_id when reporting it.",
			"Do not use background_bash for interactive commands that require stdin.",
		],
		parameters: schema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<AgentToolResult<BackgroundBashDetails>> {
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
				abortController: new AbortController(),
				startedAt: Date.now(),
			};
			activeJobs.set(job.id, job);

			// Intentionally delegates to Pi's built-in bash tool instead of reimplementing
			// output handling. This preserves native bash semantics: combined stdout/stderr,
			// tail truncation, full-output temp files, "(no output)", nonzero exit text, and
			// timeout text. If Pi bash changes, background_bash should inherit that behavior.
			// Source: @mariozechner/pi-coding-agent/dist/core/tools/bash.js
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
				if (shuttingDown) return;

				const durationMs = Date.now() - job.startedAt;
				const content = buildXmlResult(job, outcome, exitCode, durationMs, body);
				const details: BackgroundBashDetails = {
					...(latestDetails ?? {}),
					jobId: job.id,
					command: job.command,
					outcome,
					exitCode,
					durationMs,
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
				details: { jobId: job.id, command: job.command, outcome: "running", exitCode: null },
			};
		},
	});
}
