#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SCHEMA_VERSION = 1;
const DEFAULT_TAIL_LINES = 80;

function attr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;");
}

function escapeBody(value) {
  return String(value ?? "").replace(/<\/pi_context>/gi, "<\\/pi_context>");
}

function context(kind, attrs, body) {
  const renderedAttrs = Object.entries({ source: "pbb", kind, schema_version: SCHEMA_VERSION, ...attrs })
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([key, value]) => `${key}="${attr(value)}"`)
    .join(" ");
  return `<pi_context ${renderedAttrs}>\n${escapeBody(body)}\n</pi_context>`;
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

function identity() {
  const sessionKey = process.env.PI_LANE_SESSION_KEY || process.env.PBB_SESSION_KEY;
  const instanceId = process.env.PI_LANE_INSTANCE_ID || process.env.PBB_INSTANCE_ID;
  const root = process.env.PBB_ROOT || join(homedir(), ".pi", "pbb");
  return {
    sessionId: process.env.PI_LANE_SESSION_ID || process.env.PBB_SESSION_ID || "",
    sessionKey: sessionKey || "",
    sessionFile: process.env.PI_LANE_SESSION_FILE || process.env.PBB_SESSION_FILE || "",
    instanceId: instanceId || "",
    lane: process.env.PI_LANE_CURRENT_LANE || process.env.PBB_LANE || "",
    laneRoot: process.env.PI_LANE_ROOT || "",
    root,
    scopeDefault: "current-instance",
    hasLaneEnv: Boolean(process.env.PI_LANE_SESSION_KEY && process.env.PI_LANE_INSTANCE_ID),
  };
}

function requireIdentity(id) {
  if (!id.sessionKey || !id.instanceId) {
    console.error(context("pbb.error", { scope: "none" }, `<summary>pbb cannot determine current Pi lane identity</summary>\nRun inside Pi with pi-lane installed, or set PI_LANE_SESSION_KEY and PI_LANE_INSTANCE_ID.`));
    process.exit(3);
  }
}

function sessionDir(id) {
  return join(id.root, "sessions", id.sessionKey);
}

function instanceDir(id, instanceId = id.instanceId) {
  return join(sessionDir(id), "instances", instanceId);
}

function jobsDir(id, instanceId = id.instanceId) {
  return join(instanceDir(id, instanceId), "jobs");
}

function logsDir(id, instanceId = id.instanceId) {
  return join(instanceDir(id, instanceId), "logs");
}

function requestsDir(id, instanceId = id.instanceId) {
  return join(instanceDir(id, instanceId), "requests");
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function listInstanceIds(id, scope, explicitInstance) {
  if (explicitInstance) return [explicitInstance];
  if (scope === "current-instance") return [id.instanceId];
  const dir = join(sessionDir(id), "instances");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function readJobs(id, { scope = "current-instance", instance } = {}) {
  const jobs = [];
  for (const iid of listInstanceIds(id, scope, instance)) {
    const dir = jobsDir(id, iid);
    if (!existsSync(dir)) continue;
    for (const item of readdirSync(dir)) {
      if (!item.endsWith(".json")) continue;
      const job = readJson(join(dir, item));
      if (job) jobs.push(job);
    }
  }
  return jobs.sort((a, b) => String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? "")) || String(a.jobId).localeCompare(String(b.jobId)));
}

function findJob(id, jobId, opts) {
  const jobs = readJobs(id, opts).filter((job) => job.jobId === jobId || job.globalJobId === jobId);
  if (jobs.length === 0) return { error: "missing", jobs };
  if (jobs.length > 1) return { error: "ambiguous", jobs };
  return { job: jobs[0], jobs };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--full") out.full = true;
    else if (arg === "--scope") out.scope = argv[++i];
    else if (arg === "--instance") out.instance = argv[++i];
    else if (arg === "--since" || arg === "--cursor") out.since = argv[++i];
    else if (arg === "--lines" || arg === "-n") out.lines = Number(argv[++i]);
    else if (arg === "--signal") out.signal = argv[++i];
    else out._.push(arg);
  }
  return out;
}

function printSelf(id, opts) {
  const payload = {
    kind: "pbb.self",
    schemaVersion: SCHEMA_VERSION,
    sessionId: id.sessionId,
    sessionKey: id.sessionKey,
    sessionFile: id.sessionFile,
    instanceId: id.instanceId,
    lane: id.lane,
    root: id.root,
    laneRoot: id.laneRoot,
    defaultScope: id.scopeDefault,
    hasLaneEnv: id.hasLaneEnv,
  };
  if (opts.json) return console.log(json(payload));
  console.log(context("pbb.self", {
    session_id: id.sessionId,
    session_key: id.sessionKey,
    session_file: id.sessionFile,
    instance_id: id.instanceId,
    lane: id.lane,
    scope: "current-instance",
  }, `<summary>current Pi background bash identity</summary>\n${json(payload)}`));
}

function formatJob(job) {
  const age = job.startedAt ? `${Math.max(0, Math.round((Date.now() - Date.parse(job.startedAt)) / 1000))}s` : "?";
  const exit = job.exitCode === undefined || job.exitCode === null ? "" : ` exit=${job.exitCode}`;
  return `- job=${job.jobId} global=${job.globalJobId} status=${job.status}${exit} age=${age} instance=${job.instanceId} cmd=${JSON.stringify(job.command ?? "")}`;
}

function printList(id, opts) {
  const scope = opts.scope || (opts.instance ? "session" : "current-instance");
  const jobs = readJobs(id, { scope, instance: opts.instance });
  const payload = { kind: "pbb.list", schemaVersion: SCHEMA_VERSION, sessionId: id.sessionId, sessionKey: id.sessionKey, instanceId: id.instanceId, lane: id.lane, scope, jobs };
  if (opts.json) return console.log(json(payload));
  const counts = jobs.reduce((acc, job) => { acc[job.status] = (acc[job.status] || 0) + 1; return acc; }, {});
  console.log(context("pbb.list", {
    session_id: id.sessionId,
    session_key: id.sessionKey,
    instance_id: id.instanceId,
    lane: id.lane,
    scope,
    jobs: jobs.length,
  }, `<summary>${jobs.length} jobs; ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ") || "none"}</summary>\n${jobs.map(formatJob).join("\n") || "No background bash jobs in scope."}`));
}

function printStatus(id, jobId, opts) {
  if (!jobId) return printList(id, opts);
  const scope = opts.scope || (opts.instance ? "session" : "current-instance");
  const result = findJob(id, jobId, { scope, instance: opts.instance });
  if (result.error === "missing") {
    console.error(context("pbb.error", { session_key: id.sessionKey, instance_id: id.instanceId, scope, job_id: jobId }, `<summary>unknown job ${jobId}</summary>`));
    process.exit(2);
  }
  if (result.error === "ambiguous") {
    console.error(context("pbb.error", { session_key: id.sessionKey, instance_id: id.instanceId, scope, job_id: jobId }, `<summary>ambiguous job ${jobId}</summary>\n${result.jobs.map((job) => `${job.instanceId}:${job.jobId}`).join("\n")}`));
    process.exit(3);
  }
  const job = result.job;
  if (opts.json) return console.log(json({ kind: "pbb.status", schemaVersion: SCHEMA_VERSION, sessionId: id.sessionId, sessionKey: id.sessionKey, instanceId: id.instanceId, lane: id.lane, scope, job }));
  console.log(context("pbb.status", { session_id: id.sessionId, session_key: id.sessionKey, instance_id: id.instanceId, lane: id.lane, scope, job_id: job.jobId, owner_instance_id: job.instanceId, status: job.status, cursor: job.lastEventId }, `<summary>${job.jobId} ${job.status}${job.exitCode == null ? "" : ` exit=${job.exitCode}`}</summary>\n${json(job)}`));
}

function tailText(path, lines, full) {
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8");
  if (full) return text;
  const split = text.split(/\r?\n/);
  const wanted = split.slice(-Math.max(1, lines ?? DEFAULT_TAIL_LINES));
  return wanted.join("\n");
}

function printTail(id, jobId, opts) {
  const scope = opts.scope || (opts.instance ? "session" : "current-instance");
  const result = findJob(id, jobId, { scope, instance: opts.instance });
  if (!result.job) {
    console.error(context("pbb.error", { session_key: id.sessionKey, instance_id: id.instanceId, scope, job_id: jobId }, `<summary>${result.error === "ambiguous" ? "ambiguous" : "unknown"} job ${jobId}</summary>`));
    process.exit(result.error === "ambiguous" ? 3 : 2);
  }
  const job = result.job;
  const logPath = job.logPath || join(logsDir(id, job.instanceId), `${job.jobId}.log`);
  const body = tailText(logPath, opts.lines, opts.full);
  if (opts.json) return console.log(json({ kind: "pbb.tail", schemaVersion: SCHEMA_VERSION, sessionId: id.sessionId, sessionKey: id.sessionKey, instanceId: id.instanceId, lane: id.lane, scope, job, log: body }));
  console.log(context("pbb.tail", { session_id: id.sessionId, session_key: id.sessionKey, instance_id: id.instanceId, lane: id.lane, scope, job_id: job.jobId, owner_instance_id: job.instanceId, status: job.status, cursor: job.lastEventId, lines: opts.full ? "full" : (opts.lines || DEFAULT_TAIL_LINES) }, `<summary>${job.jobId} ${job.status}; showing ${opts.full ? "full log" : `last ${opts.lines || DEFAULT_TAIL_LINES} lines`}</summary>\n${body || "No log output recorded yet."}`));
}

function printKill(id, jobId, opts) {
  const scope = opts.scope || (opts.instance ? "session" : "current-instance");
  const result = findJob(id, jobId, { scope, instance: opts.instance });
  if (!result.job) {
    console.error(context("pbb.error", { session_key: id.sessionKey, instance_id: id.instanceId, scope, job_id: jobId }, `<summary>${result.error === "ambiguous" ? "ambiguous" : "unknown"} job ${jobId}</summary>`));
    process.exit(result.error === "ambiguous" ? 3 : 2);
  }
  const job = result.job;
  if (!["running", "kill_requested"].includes(job.status)) {
    console.log(context("pbb.kill", { session_id: id.sessionId, session_key: id.sessionKey, instance_id: id.instanceId, lane: id.lane, scope, job_id: job.jobId, owner_instance_id: job.instanceId, status: job.status }, `<summary>${job.jobId} is not running; no kill requested</summary>`));
    return;
  }
  const requestId = `kill_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const request = {
    schemaVersion: SCHEMA_VERSION,
    type: "kill",
    requestId,
    jobId: job.jobId,
    globalJobId: job.globalJobId,
    sessionId: id.sessionId,
    sessionKey: id.sessionKey,
    instanceId: job.instanceId,
    requestedByInstanceId: id.instanceId,
    signal: opts.signal || "TERM",
    requestedAt: new Date().toISOString(),
  };
  writeJsonFile(join(requestsDir(id, job.instanceId), `${requestId}.json`), request);
  console.log(context("pbb.kill", { session_id: id.sessionId, session_key: id.sessionKey, instance_id: id.instanceId, lane: id.lane, scope, job_id: job.jobId, owner_instance_id: job.instanceId, request_id: requestId, status: job.status }, `<summary>kill requested for ${job.jobId}</summary>\nThe owning pi-background-bash runtime will abort the job if it is still live.`));
}

const opts = parseArgs(process.argv.slice(2));
const command = opts._[0] || "list";
const id = identity();

if (["help", "--help", "-h"].includes(command)) {
  console.log(`pbb - Pi background bash inspector\n\nCommands:\n  pbb self [--json]\n  pbb list [--scope current-instance|session] [--instance ID] [--json]\n  pbb status [JOB] [--json]\n  pbb tail JOB [-n LINES] [--full] [--json]\n  pbb kill JOB\n\nDefaults to the current pi-lane instance using PI_LANE_* env vars.`);
  process.exit(0);
}

if (command === "self" || command === "whoami") {
  printSelf(id, opts);
  process.exit(0);
}

requireIdentity(id);
mkdirSync(instanceDir(id), { recursive: true });

if (command === "list" || command === "ls") printList(id, opts);
else if (command === "status") printStatus(id, opts._[1], opts);
else if (command === "tail") {
  if (!opts._[1]) {
    console.error("Usage: pbb tail <job>");
    process.exit(2);
  }
  printTail(id, opts._[1], opts);
} else if (command === "kill") {
  if (!opts._[1]) {
    console.error("Usage: pbb kill <job>");
    process.exit(2);
  }
  printKill(id, opts._[1], opts);
} else {
  console.error(`Unknown pbb command: ${command}`);
  process.exit(2);
}
