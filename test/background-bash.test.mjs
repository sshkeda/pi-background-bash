import { test } from "node:test";
import assert from "node:assert/strict";
import { createMock, script, text, toolCall } from "pi-mock";
import { existsSync, rmSync } from "node:fs";
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
  return messageTexts(req).filter((text) => text.includes("<background_bash_result"));
}

function backgroundResultText(req) {
  return backgroundResultTexts(req).at(-1) ?? "";
}

async function createBgMock(brain) {
  return createMock({
    brain,
    extensions: [EXT],
    startupTimeoutMs: 20_000,
    runTimeoutMs: TIMEOUT,
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

    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<background_bash_result"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /<background_bash_result job_id="bg_1"/);
    assert.match(textReq, /outcome="exit"/);
    assert.match(textReq, /exit_code="0"/);
    assert.match(textReq, /command="sleep 0\.1; echo done"/);
    assert.match(textReq, /done/);
    assert.match(textReq, /<\/background_bash_result>/);
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
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<background_bash_result"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /outcome="exit"/);
    assert.match(textReq, /exit_code="7"/);
    assert.match(textReq, /bad/);
    assert.match(textReq, /Command exited with code 7/);
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
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<background_bash_result"), TIMEOUT);
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

    const first = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<background_bash_result"), TIMEOUT);
    const second = await mock.waitForRequest((req, i) => i > first.index && requestText(req).includes("<background_bash_result"), TIMEOUT);
    const both = [...backgroundResultTexts(first.request), ...backgroundResultTexts(second.request)].join("\n");
    assert.match(both, /job_id="bg_1"/);
    assert.match(both, /job_id="bg_2"/);
  } finally {
    await mock.close();
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
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<background_bash_result"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /Showing lines \d+-\d+ of \d+\. Full output:/);
    assert.match(textReq, /line 2104/);
  } finally {
    await mock.close();
  }
});
