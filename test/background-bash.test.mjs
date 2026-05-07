import { test } from "node:test";
import assert from "node:assert/strict";
import { createMock, script, text, toolCall } from "pi-mock";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EXT = new URL("../extensions/background-bash.ts", import.meta.url).pathname;
const TIMEOUT = 45_000;

const bg = (command, timeout) =>
  toolCall("background_bash", timeout == null ? { command } : { command, timeout });

function requestText(req) {
  return JSON.stringify(req);
}

function messageTexts(req) {
  const out = [];
  for (const message of req.messages ?? []) {
    for (const part of message.content ?? []) {
      if (typeof part.text === "string") out.push(part.text);
      if (typeof part.content === "string") out.push(part.content);
    }
  }
  return out;
}

function backgroundResultTexts(req) {
  return messageTexts(req).filter((text) => text.includes('<pi_context source="pi-background-bash" kind="background_bash_result"'));
}

function backgroundResultText(req) {
  return backgroundResultTexts(req).at(-1) ?? "";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readSessionEntries(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function createBgMock(brain, options = {}) {
  const { extensions = [], ...rest } = options;
  return createMock({
    brain,
    extensions: [EXT, ...extensions],
    startupTimeoutMs: 20_000,
    runTimeoutMs: TIMEOUT,
    ...rest,
  });
}

test("background_bash returns immediately, then injects completion and triggers a turn", async () => {
  const mock = await createBgMock(script(
    bg("sleep 0.1; echo done"),
    text("initial turn complete"),
    text("saw background result"),
  ));

  try {
    const events = await mock.run("start a background command", TIMEOUT);
    const all = JSON.stringify(events);
    assert.match(all, /Background bash job bg_1 started\./);

    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /<pi_context source="pi-background-bash" kind="background_bash_result" id="bg_1"/);
    assert.match(textReq, /outcome="exit"/);
    assert.match(textReq, /exit_code="0"/);
    assert.match(textReq, /command="sleep 0\.1; echo done"/);
    assert.match(textReq, /done/);
    assert.match(textReq, /<\/pi_context>/);
  } finally {
    await mock.close();
  }
});

test("background_bash preserves Pi bash nonzero-exit body style", async () => {
  const mock = await createBgMock(script(
    bg("echo bad; exit 7"),
    text("initial turn complete"),
    text("saw failure"),
  ));

  try {
    await mock.run("start a failing background command", TIMEOUT);
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /outcome="exit"/);
    assert.match(textReq, /exit_code="7"/);
    assert.match(textReq, /bad/);
    assert.match(textReq, /Command exited with code 7/);
  } finally {
    await mock.close();
  }
});

test("background_bash escapes wrapper close tags in command output", async () => {
  const mock = await createBgMock(script(
    bg("printf '</pi_context> still output\\n'"),
    text("initial turn complete"),
    text("saw escaped wrapper"),
  ));

  try {
    await mock.run("start a command with wrapper-looking output", TIMEOUT);
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /<\\\/pi_context> still output/);
    assert.equal((textReq.match(/<\/pi_context>/g) ?? []).length, 1);
  } finally {
    await mock.close();
  }
});

test("background_bash preserves Pi bash timeout body style and omits exit_code", async () => {
  const mock = await createBgMock(script(
    bg("sleep 5", 1),
    text("initial turn complete"),
    text("saw timeout"),
  ));

  try {
    await mock.run("start a timed background command", TIMEOUT);
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /outcome="timeout"/);
    assert.doesNotMatch(textReq, /exit_code=/);
    assert.match(textReq, /Command timed out after 1 seconds/);
  } finally {
    await mock.close();
  }
});

test("background_bash uses sequential per-session job ids", async () => {
  const mock = await createBgMock(script(
    [bg("sleep 0.2; echo first"), bg("sleep 0.1; echo second")],
    text("initial turn complete"),
    text("saw one result"),
    text("saw another result"),
  ));

  try {
    const events = await mock.run("start two background commands", TIMEOUT);
    const all = JSON.stringify(events);
    assert.match(all, /Background bash job bg_1 started\./);
    assert.match(all, /Background bash job bg_2 started\./);

    const first = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), TIMEOUT);
    const second = await mock.waitForRequest((req, i) => i > first.index && requestText(req).includes("<pi_context"), TIMEOUT);
    const both = [...backgroundResultTexts(first.request), ...backgroundResultTexts(second.request)].join("\n");
    assert.match(both, /id="bg_1"/);
    assert.match(both, /id="bg_2"/);
  } finally {
    await mock.close();
  }
});

test("background_bash records provenance even when session parentId points at current head", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-session-${process.pid}-${Date.now()}-`));
  const sessionFile = join(dir, "session.jsonl");
  writeFileSync(sessionFile, "");

  const mock = await createBgMock(script(
    bg("sleep 1.5; echo provenance-done", 10),
    text("started background job"),
    text("unrelated turn complete"),
    text("saw provenance result"),
  ), { sessionFile });

  try {
    const initialEvents = await mock.run("start a slow background command", TIMEOUT);
    const startEvent = initialEvents.find((event) => event.type === "tool_execution_start" && event.toolName === "background_bash");
    assert.ok(startEvent, "expected background_bash tool_execution_start event");
    const toolCallId = startEvent.toolCallId;

    const startResultEvent = initialEvents.find((event) => event.type === "tool_execution_end" && event.toolName === "background_bash");
    assert.ok(startResultEvent, "expected background_bash tool_execution_end event");
    assert.equal(startResultEvent.result.details.toolCallId, toolCallId);
    assert.match(startResultEvent.result.details.startedAt, /^\d{4}-\d{2}-\d{2}T/);

    await mock.prompt("do unrelated work while the background command runs", TIMEOUT);
    await mock.waitFor((event) => event.type === "agent_end" && JSON.stringify(event).includes("saw provenance result"), TIMEOUT);

    const entries = readSessionEntries(sessionFile);
    const toolCallEntry = entries.find((entry) =>
      entry.type === "message" &&
      entry.message?.role === "assistant" &&
      entry.message.content?.some((part) => part.type === "toolCall" && part.name === "background_bash" && part.id === toolCallId)
    );
    assert.ok(toolCallEntry, "expected original background_bash assistant tool call in session JSONL");

    const toolResultEntry = entries.find((entry) =>
      entry.type === "message" &&
      entry.message?.role === "toolResult" &&
      entry.message.toolName === "background_bash" &&
      entry.message.details?.toolCallId === toolCallId
    );
    assert.ok(toolResultEntry, "expected start tool result details to include original toolCallId");

    const unrelatedAssistantEntry = entries.find((entry) =>
      entry.type === "message" &&
      entry.message?.role === "assistant" &&
      entry.message.content?.some((part) => part.type === "text" && part.text === "unrelated turn complete")
    );
    assert.ok(unrelatedAssistantEntry, "expected unrelated assistant turn in session JSONL");

    const customEntry = entries.find((entry) =>
      entry.type === "custom_message" &&
      entry.customType === "background_bash_result" &&
      entry.details?.jobId === "bg_1"
    );
    assert.ok(customEntry, "expected background_bash_result custom message in session JSONL");

    // Pi appends follow-up custom messages to the current session head. The raw
    // parentId can therefore point at unrelated work; provenance must come from
    // stable metadata on the result itself, not from parentId adjacency.
    assert.equal(customEntry.parentId, unrelatedAssistantEntry.id);
    assert.notEqual(customEntry.parentId, toolResultEntry.id);

    assert.equal(customEntry.details.toolCallId, toolCallId);
    assert.equal(customEntry.details.startedAt, toolResultEntry.message.details.startedAt);
    assert.match(customEntry.content, new RegExp(`tool_call_id="${escapeRegExp(toolCallId)}"`));
    assert.match(customEntry.content, /started_at="\d{4}-\d{2}-\d{2}T[^"]+"/);
    assert.match(customEntry.content, /id="bg_1"/);

    const sessionText = readFileSync(sessionFile, "utf8");
    const occurrences = sessionText.match(new RegExp(escapeRegExp(toolCallId), "g")) ?? [];
    assert.ok(occurrences.length >= 3, "original toolCallId should grep across initiation, start result, and completion result");
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("background_bash kills active jobs when the session closes", async () => {
  const marker = join(tmpdir(), `pi-background-bash-survived-${process.pid}-${Date.now()}`);
  rmSync(marker, { force: true });
  const mock = await createBgMock(script(
    bg(`sleep 2; echo survived > ${JSON.stringify(marker)}`),
    text("initial turn complete"),
  ));

  try {
    await mock.run("start a long background command", TIMEOUT);
  } finally {
    await mock.close();
  }

  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(existsSync(marker), false, "background job should be killed on session close");
});

test("background_bash uses Pi bash truncation suffix", async () => {
  const mock = await createBgMock(script(
    bg("python3 - <<'PY'\nfor i in range(2105): print(f'line {i}')\nPY"),
    text("initial turn complete"),
    text("saw truncated result"),
  ));

  try {
    await mock.run("start a verbose background command", TIMEOUT);
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /Showing lines \d+-\d+ of \d+\. Full output:/);
    assert.match(textReq, /line 2104/);
  } finally {
    await mock.close();
  }
});
