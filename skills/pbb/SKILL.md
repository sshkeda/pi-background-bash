---
name: pbb
description: Inspect Pi background bash jobs with the pbb CLI. Use when checking status, tailing output, or debugging long-running bash commands started by pi-background-bash.
---

# pbb — Pi Background Bash inspector

Use `pbb` to inspect background bash jobs instead of rerunning long commands just to check progress.

## Identity model

`pbb` uses `pi-lane` runtime identity when available:

- `session_id`: persisted Pi conversation
- `session_key`: stable lane session key
- `instance_id`: this live Pi runtime
- `lane`: current pi-lane lane

Default scope is **current instance**. Do not assume jobs from other terminals are yours.

## Commands

```bash
pbb self
pbb list
pbb status <job_id>
pbb tail <job_id> [-n 80]
pbb kill <job_id>
```

Use broader scopes only intentionally:

```bash
pbb list --scope session
pbb status --instance <instance_id> <job_id>
pbb tail --instance <instance_id> <job_id>
```

## Agent guidelines

- After starting a long background bash, use `pbb list` or `pbb status <job>` to inspect it.
- Use `pbb tail <job>` for bounded output instead of rerunning the command.
- Treat `pbb` output as authoritative for session/instance/job identity.
- If a job is ambiguous or belongs to another instance, ask before operating on it.
- `pbb kill` is intentionally conservative; same-instance control is safest.
