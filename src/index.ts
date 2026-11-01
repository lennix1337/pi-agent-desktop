import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { COMMANDS, execute } from './cli.ts';

export default function extension(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'desktop', label: 'Desktop',
    description: 'Native desktop apps (Windows/macOS/Linux) through vercel-labs/agent-desktop and the OS accessibility tree. Loop: snapshot (--app X, -i for interactive refs) -> act on an @ref (click, type, set-value, press...) -> snapshot again to verify. Observing commands (snapshot, find, get, is, screenshot, list-*, status, wait) change nothing; acting commands drive real apps the user may be using, so act only on what the task names. Default delivery is semantic and headless; headed: true moves the real cursor/keyboard and is required by physical commands (mouse-*, drag, hover, double-click, key-down/up). screenshot returns a PNG. Read the pi-agent-desktop skill first; `skills` with args ["get","desktop"] gives the full guide.',
    parameters: Type.Object({
      command: Type.Optional(Type.Unsafe<string>({ type: 'string', enum: COMMANDS, description: 'agent-desktop subcommand; default status.' })),
      args: Type.Optional(Type.Array(Type.String({ maxLength: 32768 }), { maxItems: 64, description: 'Arguments after the subcommand, e.g. ["--app","notepad.exe","-i"] or ["@e3"]. Run without a shell. Never include credentials without task authority.' })),
      headed: Type.Optional(Type.Boolean({ description: 'Physical input: real cursor/keyboard and focus changes.' })),
      verify: Type.Optional(Type.String({ maxLength: 64, description: 'Window id (from list-windows) to screenshot right after a successful action; the PNG comes back in the same result, saving a separate screenshot call.' })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Character offset into a long result.' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50000, description: 'Characters returned; default 12000.' })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      const result = await execute(params, signal);
      const content: ({ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string })[] = [{ type: 'text', text: result.text }];
      if (result.image) content.push({ type: 'image', mimeType: 'image/png', data: result.image });
      return { content, details: result.value, isError: result.isError };
    },
  });
}
