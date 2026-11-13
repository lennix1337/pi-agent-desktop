import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { accessSync, chmodSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, platform, arch } from 'node:os';
import { dirname, join } from 'node:path';

/** Commands that only observe. Everything else changes desktop state. */
export const OBSERVE = new Set([
  'snapshot', 'find', 'get', 'is', 'screenshot', 'list-windows', 'list-displays', 'list-apps',
  'list-surfaces', 'list-notifications', 'clipboard-get', 'wait', 'status', 'permissions', 'version', 'skills', 'trace',
]);

/** Commands that need physical input (cursor/keyboard focus side effects). */
export const PHYSICAL = new Set([
  'double-click', 'triple-click', 'hover', 'drag', 'mouse-move', 'mouse-click', 'mouse-down', 'mouse-up', 'mouse-wheel', 'key-down', 'key-up',
]);

export const ACT = new Set([
  'click', 'right-click', 'type', 'set-value', 'clear', 'focus', 'select', 'toggle', 'check', 'uncheck', 'expand', 'collapse',
  'scroll', 'scroll-to', 'press', 'launch', 'close-app', 'focus-window', 'resize-window', 'move-window', 'minimize', 'maximize',
  'restore', 'open-system-surface', 'dismiss-notification', 'dismiss-all-notifications', 'notification-action', 'clipboard-set', 'clipboard-clear',
]);

export const COMMANDS = [...OBSERVE, ...ACT, ...PHYSICAL];

export interface Params { command?: string; args?: string[]; headed?: boolean; offset?: number; limit?: number; verify?: string }
export interface Result { value: unknown; text: string; image?: string; isError: boolean }
export type Runner = (bin: string, args: string[], signal?: AbortSignal) => Promise<{ code: number; stdout: string; stderr: string }>;

export function binaryPath(): string {
  const env = process.env.PI_AGENT_DESKTOP_BIN;
  if (env) return env;
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('agent-desktop/package.json');
  const entry = require('agent-desktop/lib/platform').resolve(platform(), arch());
  if (!entry?.released) throw new Error(`agent-desktop has no binary for ${platform()}-${arch()}`);
  const bin = join(dirname(pkg), 'bin', entry.binaryName);
  // npm 11+ skips agent-desktop's postinstall by default, which is what marks the binary executable.
  if (platform() !== 'win32') try { accessSync(bin, constants.X_OK); } catch { chmodSync(bin, 0o755); }
  return bin;
}

export const run: Runner = (bin, args, signal) => new Promise(resolve => {
  execFile(bin, args, { signal, maxBuffer: 64 << 20, windowsHide: true, timeout: 120_000 }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stdout ? err.message : '')) });
  });
});

/** Pointer commands that take one point as `--xy X,Y`; mouse-wheel alone takes `--x X --y Y`. */
const XY_POINT = new Set(['mouse-click', 'mouse-move', 'mouse-down', 'mouse-up', 'hover']);

/** Accept either point form on every pointer command and hand agent-desktop the one it parses. */
function pointArgs(command: string, args: string[]): string[] {
  if (command === 'mouse-wheel') {
    const i = args.indexOf('--xy');
    const [x, y] = i >= 0 ? (args[i + 1] ?? '').split(',') : [];
    return x && y ? [...args.slice(0, i), '--x', x, '--y', y, ...args.slice(i + 2)] : args;
  }
  if (!XY_POINT.has(command)) return args;
  const xi = args.indexOf('--x'), yi = args.indexOf('--y');
  if (xi < 0 || yi < 0 || args.includes('--xy')) return args;
  const rest = args.filter((_, j) => ![xi, xi + 1, yi, yi + 1].includes(j));
  return [...rest.slice(0, Math.min(xi, yi)), '--xy', `${args[xi + 1]},${args[yi + 1]}`, ...rest.slice(Math.min(xi, yi))];
}

/** Validate a request; returns an error message or the argv to run. */
export function plan(p: Params): { error: string } | { argv: string[] } {
  const command = p.command ?? 'status';
  if (!COMMANDS.includes(command)) return { error: `Unknown or unsupported command "${command}". Supported: ${COMMANDS.join(', ')}.` };
  if ((p.args ?? []).some(a => typeof a !== 'string')) return { error: 'args must be strings.' };
  const args = pointArgs(command, p.args ?? []);
  if (args.includes('--headed')) return { error: 'Pass headed: true instead of --headed in args.' };
  if (PHYSICAL.has(command) && !p.headed) return { error: `${command} moves the real cursor/keyboard; set headed: true only when the task needs physical input.` };
  if (p.verify !== undefined && OBSERVE.has(command)) return { error: 'verify attaches a screenshot after an action; observing commands need none.' };
  if (args.includes('--debug')) return { error: '--debug writes files beside the binary; not supported here.' };
  return { argv: [command, ...args, ...(p.headed ? ['--headed'] : [])] };
}

const UNEXPECTED_ARG = /unexpected argument '([^']+)'/;

/** The long options a clap help text lists, with the closest one to the rejected flag when there is one. */
export function optionsHint(help: string, rejected: string): string | undefined {
  const options = [...new Set([...help.matchAll(/^\s+(?:-\w,\s+)?(--[a-z][\w-]*)/gm)].map(m => m[1]))].filter(o => o !== '--help');
  if (!options.length) return undefined;
  const close = rejected.startsWith('--') ? options.find(o => o.startsWith(rejected) || rejected.startsWith(o)) : undefined;
  return `Valid options: ${options.join(', ')}.${close ? ` Did you mean ${close}?` : ''}`;
}

export const SNAPSHOT_TIMEOUT_HINT = 'Chromium/Electron trees time out at any --timeout-ms; retry with --max-depth 3 (measured: 129 ms on Slack), or use screenshot.';

export function page(text: string, offset = 0, limit = 12000): string {
  if (offset === 0 && text.length <= limit) return text;
  const slice = text.slice(offset, offset + limit);
  const next = offset + slice.length;
  return next < text.length ? `${slice}\n[truncated: ${text.length} chars; repeat with offset ${next}]` : slice;
}

export async function execute(p: Params, signal?: AbortSignal, runner: Runner = run, bin = binaryPath()): Promise<Result> {
  const planned = plan(p);
  if ('error' in planned) return { value: { ok: false, error: planned.error }, text: JSON.stringify({ ok: false, error: planned.error }), isError: true };
  let argv = planned.argv, shot: string | undefined, dir: string | undefined;
  if (argv[0] === 'screenshot' && !(p.args ?? []).some(a => !a.startsWith('-') && /\.png$/i.test(a))) {
    dir = mkdtempSync(join(tmpdir(), 'pi-agent-desktop-'));
    shot = join(dir, 'shot.png');
    argv = [...argv, shot];
  }
  try {
    const out = await runner(bin, argv, signal);
    let value: unknown;
    try { value = JSON.parse(out.stdout); } catch { value = { ok: out.code === 0, stdout: out.stdout.trim(), stderr: out.stderr.trim() }; }
    const ok = out.code === 0 && (value as { ok?: unknown }).ok !== false;
    let image = shot && existsSync(shot) ? readFileSync(shot).toString('base64') : undefined;
    if (ok && p.verify) {
      dir ??= mkdtempSync(join(tmpdir(), 'pi-agent-desktop-'));
      const after = join(dir, 'after.png');
      await runner(bin, ['screenshot', '--window-id', p.verify, after], signal);
      if (existsSync(after)) image = readFileSync(after).toString('base64');
    }
    const rejected = !ok ? UNEXPECTED_ARG.exec(String((value as { error?: { message?: unknown } }).error?.message ?? ''))?.[1] : undefined;
    if (rejected && (value as { error?: { code?: string } }).error?.code === 'INVALID_ARGS') {
      const help = await runner(bin, [argv[0], '--help'], signal);
      const hint = help.code === 0 ? optionsHint(help.stdout, rejected) : undefined;
      if (hint) (value as Record<string, unknown>).hint = hint;
    }
    const timedOut = argv[0] === 'snapshot' && (value as { error?: { code?: string } }).error?.code === 'TIMEOUT';
    if (timedOut) (value as Record<string, unknown>).hint = SNAPSHOT_TIMEOUT_HINT;
    const text = page(typeof value === 'string' ? value : JSON.stringify(value), p.offset, p.limit);
    return { value, text, image, isError: !ok };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
