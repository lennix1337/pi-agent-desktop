import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { COMMANDS, execute } from './cli.ts';
import { runCell } from './exec.ts';

export default function extension(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'desktop', label: 'Desktop',
    description: 'Native desktop apps (Windows/macOS/Linux) through vercel-labs/agent-desktop and the OS accessibility tree. Multi-step work: command "exec" with code, an async JS cell whose helpers are win(app, title?) (sets W), snap(), find(), click(ref), type(ref, text), keys(text), press(combo), at(x, y) and wheel(dy) (window-screenshot pixels, need headed), shot(), sleep(ms), ad(command, ...args); values assigned without let/const persist between cells, and an acting cell returns a screenshot of W. One command: snapshot (--app X, -i for refs), click/type/press on an @ref, list-windows, screenshot... Observing commands change nothing; acting ones drive real apps the user may be using, so act only on what the task names. Default delivery is semantic and headless; headed: true moves the real cursor/keyboard and is required by physical input (mouse-*, drag, hover, double-click, key-down/up, at, wheel). Read the pi-agent-desktop skill first.',
    parameters: Type.Object({
      command: Type.Optional(Type.Unsafe<string>({ type: 'string', enum: ['exec', ...COMMANDS], description: 'exec (run code) or one agent-desktop subcommand; default status.' })),
      code: Type.Optional(Type.String({ maxLength: 65536, description: 'exec: body of an async JavaScript function using the helpers; return a value to see it.' })),
      args: Type.Optional(Type.Array(Type.String({ maxLength: 32768 }), { maxItems: 64, description: 'Arguments after the subcommand, e.g. ["--app","notepad.exe","-i"] or ["@e3"]. Run without a shell. Never include credentials without task authority.' })),
      headed: Type.Optional(Type.Boolean({ description: 'Physical input: real cursor/keyboard and focus changes.' })),
      verify: Type.Optional(Type.String({ maxLength: 64, description: 'Window id (from list-windows) to screenshot right after a successful action; the PNG comes back in the same result, saving a separate screenshot call.' })),
      timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 300, description: 'exec: seconds, default 30.' })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Character offset into a long result.' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50000, description: 'Characters returned; default 12000.' })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      const result = params.command === 'exec' ? await runCell(params, signal) : await execute(params, signal);
      const content: ({ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string })[] = [{ type: 'text', text: result.text }];
      if (result.image) content.push({ type: 'image', mimeType: 'image/png', data: result.image });
      return { content, details: result.value, isError: result.isError };
    },
  });
}
