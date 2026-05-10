# PBB runner regression plan

Before replacing Pi's native `createBashTool` execution for background jobs with a PBB-owned process-group runner, preserve current behavior with characterization tests.

## Strategy

Add tests that can run against both implementations:

```text
PI_BACKGROUND_BASH_RUNNER=native npm test
PI_BACKGROUND_BASH_RUNNER=pbb npm test
```

Do not switch the default runner until the PBB runner passes the same behavioral suite, plus the process-group-specific tests below.

## Current behavior to preserve

Already covered by existing tests:

- foreground commands return normal Pi bash results before auto-background threshold
- slow foreground commands auto-background after configured threshold
- `background: true` returns immediately and later injects a follow-up result
- follow-up result wakes/triggers an agent turn
- nonzero exits preserve Pi bash body style, including `Command exited with code N`
- timeout body style is preserved and omits `exit_code`
- wrapper-looking output escapes `</pi_context>` safely
- sequential per-session job ids continue from session history
- provenance survives unrelated turns via `toolCallId` and `startedAt`
- session shutdown kills active jobs
- large output preserves Pi bash truncation suffix/full-output behavior
- PBB records current pi-lane identity and can list/tail jobs
- PBB live kill requests abort active current-instance jobs

## Additional native-compat tests to add before runner rewrite

### Shell semantics

- command runs through `bash -lc` semantics
- shell variables, pipes, redirects, subshells, and `set -e` behave normally
- command runs in `ctx.cwd`
- inherited environment is available, including `PI_LANE_*`/`PBB_*`

### stdout/stderr behavior

- stdout-only output
- stderr-only output
- interleaved stdout/stderr has reasonable combined ordering
- binary-ish output does not crash rendering
- no-output command still reports completion

### update/streaming behavior

- foreground commands still stream native updates before threshold
- after auto-background, foreground updates stop being forwarded to the original tool call
- PBB log receives output after backgrounding

### abort/timeout behavior

- abort before threshold behaves like native bash abort
- timeout after backgrounding records timeout and completion result
- session shutdown aborts backgrounded command and descendants when supported

### active job limits

- max active jobs enforcement still works
- completed/aborted jobs are removed from active count

### rendering/session behavior

- custom background result renderer still delegates to native bash renderer
- full output temp-path notice does not duplicate in display
- custom message details include job id, tool call id, cwd, duration, outcome, and PBB identity

## PBB-owned runner-specific tests

Status: initial PBB runner is implemented behind `PI_BACKGROUND_BASH_RUNNER=pbb` for explicit `background: true` jobs. The native runner remains default.

### Process groups

- [x] background job records `pid` and `pgid`
- [x] `pbb kill` sends a signal to the process group for PBB-runner live jobs via mailbox/abort
- [x] grandchildren are killed; marker file is not written after kill
- [ ] session shutdown kills the process group
- [ ] timeout kills the process group

### Stale/orphan handling

- [x] if owner instance heartbeat is stale but `pgid` is alive, `pbb kill --stale` can kill it explicitly
- [x] stale kill requires explicit flag; default kill should not unexpectedly kill another instance's job
- [ ] pid/pgid reuse is guarded by started-at/process metadata where practical

### Signal semantics

- [x] default `pbb kill` sends TERM first
- [ ] optional escalation to KILL works
- [x] `--signal INT|TERM|KILL` is accepted for CLI stale kill requests
- [ ] `--signal INT|TERM|KILL` is recorded in events for all kill paths
- [x] killed live PBB-runner jobs record `outcome=abort` consistently

### CLI safety

- [x] default scope is current instance
- [x] ambiguous job ids across instances fail loudly
- [x] cross-instance kill requires `--instance` or explicit global job id
- [x] stale owner warnings are visible in `pbb list/status`

## Acceptance gate

The runner rewrite is acceptable only when:

1. Existing tests pass unchanged.
2. New native-compat tests pass for both native and PBB runner modes.
3. PBB-owned process-group tests pass.
4. README documents any intentional behavior differences.
