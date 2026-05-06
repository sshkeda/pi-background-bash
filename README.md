# pi-background-bash

Pi extension that adds `background_bash`: Pi `bash`, but asynchronous.

## Tool

```ts
background_bash({ command: string, timeout?: number })
```

The tool returns immediately with a deterministic job id. When the command finishes, the extension injects one `<background_bash_result>` message into the session and wakes the agent.

The result body delegates to Pi's built-in `bash` tool, so output formatting matches native Pi bash behavior: combined stdout/stderr, tail truncation, full-output temp files, `(no output)`, nonzero exit text, and timeout text.

## Install locally

```bash
pi install /Users/sshkeda/GitHub/pi-background-bash
```

Or test without installing:

```bash
pi -e /Users/sshkeda/GitHub/pi-background-bash
```
