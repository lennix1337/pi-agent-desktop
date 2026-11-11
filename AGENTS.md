# pi-agent-desktop

Pi extension that exposes one `desktop` tool over the [agent-desktop](https://github.com/vercel-labs/agent-desktop) CLI and the OS accessibility tree, plus the `pi-agent-desktop` skill. Read `README.md` for the user-visible loop and safety rules.

- `src/cli.ts` plans and admits each call (argument shape, refused commands, `headed` gate, paging, screenshots); `src/index.ts` registers the tool. Keep admission in `cli.ts` so the offline tests cover it.
- Preserve the guards: no shell, physical input only with `headed: true` (never through `args`), `batch`/`session`/`cursor-overlay`/`--debug` not exposed. Each guard has a mutant in `test/mutations.mjs`; a new guard gets one.
- Checks live in `.pi/checks.json`: `verify` (types + all offline tests), `module` (CLI tests only), `mutations`. None of them drives a desktop app.
- `npm run e2e` opens, writes into and closes a real Notepad window on Windows: run it only when the task needs the real journey, never against an app the user has open.
- Releases: `npm run release` tags and pushes; the Release workflow publishes to npm with provenance. Publishing is a separate decision from merging.
