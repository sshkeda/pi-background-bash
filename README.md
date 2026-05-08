# pi-background-bash

Async/background `bash` for [Pi](https://github.com/earendil-works/pi): keep using the normal `bash` tool, but long-running commands stop blocking the agent.

`pi-background-bash` overrides Pi's built-in `bash` tool with two quality-of-life features:

- `background: true` starts a command in the background immediately.
- normal foreground commands automatically move to the background after 30 seconds.

When a background command finishes, the extension injects a follow-up result into the session and wakes the agent.

## Why

AI coding agents often need to run slow commands: test suites, builds, dev servers, downloads, deploys, benchmark loops, and watchers. Without background execution, the agent gets stuck waiting. With this extension, the agent can continue useful work and handle the command output when it arrives.

## Install

Install from GitHub:

```bash
pi install git:github.com/sshkeda/pi-background-bash
```

Try without installing:

```bash
pi -e git:github.com/sshkeda/pi-background-bash
```

Local development:

```bash
git clone https://github.com/sshkeda/pi-background-bash.git
cd pi-background-bash
npm install
npm test
pi -e .
```

## Usage

Run a command normally. If it is still running after 30 seconds, it automatically moves to the background:

```ts
bash({ command: "npm test" })
```

Start a command in the background immediately:

```ts
bash({ command: "npm test", background: true })
```

Add a timeout if you want Pi to kill the command after a fixed number of seconds:

```ts
bash({ command: "npm test", background: true, timeout: 120 })
```

Completion results arrive as Pi context messages:

```xml
<pi_context source="pi-background-bash" kind="background_bash_result" id="bg_1" outcome="exit" exit_code="0">
...
</pi_context>
```

The result body delegates to Pi's native `bash` implementation, so output formatting matches normal Pi bash behavior: combined stdout/stderr, tail truncation, full-output temp files, nonzero exit handling, timeout handling, and native bash rendering.

## Configuration

Default auto-background threshold: `30` seconds.

Configure the global threshold in `~/.pi-background-bash/config.json`:

```json
{
  "autoBackgroundAfterSeconds": 10
}
```

Disable automatic backgrounding while keeping `background: true` available:

```json
{
  "autoBackgroundAfterSeconds": 0
}
```

You can also override the threshold for a single project with `.pi/background-bash.json` in that project. Project config wins over global config.

## Agent prompt behavior

The extension updates the `bash` tool metadata exposed to models:

- the `background` boolean is part of the tool schema
- the tool description documents automatic backgrounding
- prompt snippets/guidelines teach the agent not to retry just to wait
- background completion messages are described as final bash results

No global Pi prompt patch is required.

## Security

This is a Pi extension. Like any Pi package, it runs with your local user permissions and can execute shell commands requested by the agent. Review the source before installing third-party extensions.

## Development

```bash
npm install
npm run hooks:install
npm run typecheck
npm test
```

This repo uses Lefthook for local pre-commit checks. The test suite uses [`pi-mock`](https://github.com/sshkeda/pi-mock) to exercise the extension against a real Pi process.

## License

MIT
