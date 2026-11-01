# pi-agent-desktop

A [Pi](https://github.com/earendil-works/pi) extension that lets the agent see and operate native desktop apps on Windows, macOS and Linux, through [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop) and the operating system's accessibility tree.

Not to be confused with [abcwyc/pi-agent-desktop](https://github.com/abcwyc/pi-agent-desktop), a desktop chat app for Pi. This package gives Pi a tool; it is not an app.

## Install

```sh
pi install npm:@lennix1337/pi-agent-desktop
```

The agent-desktop binary for your platform ships inside the dependency; no global install. macOS needs Accessibility (and Screen Recording for screenshots) granted to the terminal that runs Pi.

## What the agent gets

- **`desktop` tool**: one agent-desktop subcommand per call (`snapshot`, `find`, `click`, `type`, `set-value`, `press`, `screenshot`, `list-windows`, `launch`, notifications, clipboard...), run without a shell, JSON result, PNG attached for screenshots, long results paged with `offset`.
- **`pi-agent-desktop` skill**: the snapshot → act on `@ref` → verify loop and the safety rules.

## Safety

- Semantic, headless delivery by default: no cursor movement, no focus stealing.
- Physical input (`mouse-*`, `drag`, `hover`, `double-click`, `key-down/up`) is refused unless the call sets `headed: true`; `--headed` cannot be smuggled through `args`.
- `batch`, `session`, `cursor-overlay` and `--debug` are not exposed.

## Develop

```sh
npm install
npm run check   # types
npm test        # unit + Pi loader test (runs the real binary's `version`)
npm run e2e     # real desktop: opens Notepad, writes, reads back, screenshots, closes (Windows)
```

Override the binary with `PI_AGENT_DESKTOP_BIN`.

MIT. agent-desktop is Apache-2.0, © Vercel.
