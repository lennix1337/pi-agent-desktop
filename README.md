# pi-agent-desktop — computer use for Pi

[![npm](https://img.shields.io/npm/v/@lennix1337/pi-agent-desktop)](https://www.npmjs.com/package/@lennix1337/pi-agent-desktop)
[![check](https://github.com/lennix1337/pi-agent-desktop/actions/workflows/check.yml/badge.svg)](https://github.com/lennix1337/pi-agent-desktop/actions/workflows/check.yml)
[![license](https://img.shields.io/npm/l/@lennix1337/pi-agent-desktop)](LICENSE)

Give the [Pi coding agent](https://github.com/earendil-works/pi) eyes and hands on your desktop. It reads any native app on **Windows, macOS and Linux** through the operating system's accessibility tree, then clicks, types, fills fields, reads values and takes screenshots. Powered by [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop).

```sh
pi install npm:@lennix1337/pi-agent-desktop
```

No global install and no Python: the native binary for your platform ships inside the package.

## What you can ask Pi

- "Open Notepad, write the release notes and save them to my Desktop."
- "Read the error text in that installer window and tell me what it wants."
- "Fill this desktop form with the data from `customers.csv`."
- "Take a screenshot of the Settings window and check the toggle is on."

## How it works

Pi gets one **`desktop` tool** and a **`pi-agent-desktop` skill** that teaches the loop:

1. `list-apps` / `list-windows` find the target.
2. `snapshot` returns the accessibility tree as compact JSON with `@ref` ids (no pixels, cheap in tokens).
3. Act on a ref: `click`, `set-value`, `type`, `press`, `launch`, `close-app`...
4. Verify with `get` or a fresh `snapshot`; `screenshot` attaches a PNG when the tree is not enough.

Native apps snapshot in about 0.2 s. Electron/Chromium apps (Slack, VS Code) expose deep trees: snapshot them with `--max-depth 3`; the tool suggests it on timeout.

## Safety

- Semantic, headless delivery by default: no cursor movement, no focus stealing.
- Physical input (`mouse-*`, `drag`, `hover`, `double-click`, `key-down/up`) is refused unless the call sets `headed: true`; `--headed` cannot be smuggled through `args`.
- Commands run without a shell; `batch`, `session`, `cursor-overlay` and `--debug` are not exposed.
- macOS: grant Accessibility (and Screen Recording for screenshots) to the terminal that runs Pi.

## vs. other options

| | pi-agent-desktop | Screenshot + vision models | Browser tools |
|---|---|---|---|
| Native desktop apps | yes | yes | no |
| Reads exact text/values | yes (accessibility tree) | OCR guess | web only |
| Token cost per step | small JSON | large images | small |

Not to be confused with [abcwyc/pi-agent-desktop](https://github.com/abcwyc/pi-agent-desktop), a desktop chat app for Pi. This package gives Pi a tool; it is not an app.

## Develop

```sh
npm install
npm run check   # types
npm test        # unit + Pi loader test (runs the real binary's `version`)
npm run e2e     # real desktop: opens Notepad, writes, reads back, screenshots, closes (Windows)
```

Override the binary with `PI_AGENT_DESKTOP_BIN`.

## Release

`npm run release` bumps the patch version, tags it and pushes. The **Release** workflow then runs the checks and publishes to npm with provenance through npm trusted publishing (no token, no OTP), and creates the GitHub release.

MIT. agent-desktop is Apache-2.0, © Vercel.
