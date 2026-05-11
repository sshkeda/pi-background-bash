# PBB runner

PBB is the baseline bash runner for pi-background-bash v1.

## Contract

- Every command runs through `bash -lc`.
- Background jobs are owned by PBB from process start.
- Job IDs use fixed-width local IDs: `bg001`, `bg002`, ..., `bg999`, then `bg1000`.
- Jobs record `pid` and `pgid` for process-group control.
- `pbb list`, `pbb status`, and `pbb tail` inspect the recorded job state/logs.
- `pbb kill` requests live owner shutdown through the instance mailbox.
- `pbb kill --stale --instance <id> <job>` explicitly signals a stale recorded process group.
- Verbose completion messages are truncated in-session and point to `pbb tail <job> --full` for complete output.

## v1 migration stance

v1 is a hard migration to PBB-owned execution. There is no alternate native-runner mode and no compatibility shim.

If a caller depended on exact pre-v1 bash formatting, update the caller to use the v1 PBB contract above.
