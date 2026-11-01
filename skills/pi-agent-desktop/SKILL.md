---
name: pi-agent-desktop
description: Operate native desktop apps (Windows, macOS, Linux) from Pi through the `desktop` tool, backed by vercel-labs/agent-desktop and the OS accessibility tree. Use to open, read, click, type into or screenshot a desktop program (Notepad, Explorer, Slack, Office, GeneXus IDE, settings dialogs), read notifications or the clipboard, or when a task needs something no API or browser reaches. Web pages go to browser_harness instead.
---

# pi-agent-desktop

The `desktop` tool runs one `agent-desktop` subcommand per call, without a shell, and returns its JSON.

## Loop

1. Find the target: `list-apps`, then `list-windows` with `["--app","<name>"]`. Several windows of one app give `AMBIGUOUS_TARGET`: pass `--window-id <id>`.
2. Observe: `snapshot` with `["--app","<name>","-i"]` (interactive elements with `@e` refs). Large trees: add `--skeleton`, or page with `offset`.
3. Act on a ref: `click ["@e5"]`, `type ["@e7","text"]`, `set-value`, `press ["ctrl+s"]`, `select`, `check`.
4. Verify: snapshot again, or `wait` with `--text`/`--element`. A successful act result is not proof the app did what you wanted.

Refs expire when the UI changes: snapshot again before reusing one.

Chromium/Electron apps (Slack, VS Code, Teams) return `TIMEOUT` on a full `snapshot -i`, and raising `--timeout-ms` does not help (measured on Slack: 10 s, 30 s and 60 s all timed out). Use `snapshot -i --max-depth 3` (129 ms on Slack); depths 4-6 also timed out. If the shallow tree lacks the element, use `screenshot` plus `headed` physical input, or the app's API. Native apps (Notepad, Explorer, Office dialogs) snapshot in about 0.2 s at default depth.

## Safety

- The desktop is the user's live session. Act only on the apps and windows the task names; observing commands are always fine.
- Default delivery is semantic (accessibility actions, no cursor movement). `headed: true` moves the real mouse and keyboard and steals focus; use it only when a semantic action failed or the command is physical (`mouse-*`, `drag`, `hover`, `double-click`, `key-down/up`).
- `close-app --force`, typing into password fields, notification actions and clipboard writes are effects: they need the task's authority like any other write.
- `screenshot` returns an image; prefer `snapshot` text for reading.

## More

`desktop` with `command: "skills"` and `args: ["get","desktop"]` (or `"platform"`) returns the upstream guide that matches the bundled binary version. `status` and `permissions` diagnose accessibility permissions (macOS needs Accessibility and Screen Recording for the host terminal).

Binary override: `PI_AGENT_DESKTOP_BIN`.
