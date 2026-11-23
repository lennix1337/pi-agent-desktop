import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { accessSync, chmodSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, platform, arch } from 'node:os';
import { dirname, join } from 'node:path';
import { processScreenshot, readPngDimensions, validateScreenshotOptions, type Bounds, type ScreenshotOptions } from './image.ts';

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

/** Commands that change window focus or desktop/window layout; refused in nonIntrusive mode. */
export const INTRUSIVE = new Set([
  'focus-window', 'focus', 'minimize', 'maximize', 'restore', 'open-system-surface',
]);

export const COMMANDS = [...OBSERVE, ...ACT, ...PHYSICAL];

export interface Params {
  command?: string;
  args?: string[];
  headed?: boolean;
  nonIntrusive?: boolean;
  offset?: number;
  limit?: number;
  verify?: string;
  screenshot?: ScreenshotOptions;
}
export interface Result { value: unknown; text: string; image?: string; imageMimeType?: 'image/png' | 'image/jpeg'; isError: boolean }
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
  if (p.nonIntrusive) {
    if (p.headed) return { error: 'nonIntrusive cannot be combined with headed: true (headed moves the cursor and changes focus).' };
    if (INTRUSIVE.has(command)) return { error: `${command} changes window focus or layout; refused in nonIntrusive mode.` };
    if (command === 'launch' && args.includes('--activate')) return { error: 'launch --activate steals focus; omit --activate in nonIntrusive mode.' };
  }
  if (PHYSICAL.has(command) && !p.headed) return { error: `${command} moves the real cursor/keyboard; set headed: true only when the task needs physical input.` };
  if (p.verify !== undefined && OBSERVE.has(command)) return { error: 'verify attaches a screenshot after an action; observing commands need none.' };
  if (p.screenshot !== undefined) {
    if (command !== 'screenshot' && p.verify === undefined) {
      return { error: 'screenshot options apply only to the screenshot command or when verify is set.' };
    }
    const shotErr = validateScreenshotOptions(p.screenshot);
    if (shotErr) return { error: shotErr };
  }
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

/** `how` ends the notice when repeating the call does something other than run it again. */
export function page(text: string, offset = 0, limit = 12000, how = ''): string {
  if (offset === 0 && text.length <= limit) return text;
  const slice = text.slice(offset, offset + limit);
  const next = offset + slice.length;
  return next < text.length ? `${slice}\n[truncated: ${text.length} chars; repeat with offset ${next}${how}]` : slice;
}

function argFlagValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
  }
  return undefined;
}

async function resolveRefCrop(
  ref: string,
  pngBuffer: Buffer,
  args: string[],
  verifyId: string | undefined,
  signal: AbortSignal | undefined,
  runner: Runner,
  bin: string,
  knownWindowBounds?: Bounds,
): Promise<Bounds> {
  const getOut = await runner(bin, ['get', ref, '--property', 'bounds'], signal);
  let parsed: { ok?: boolean; data?: { value?: Bounds }; error?: { message?: string } };
  try { parsed = JSON.parse(getOut.stdout); } catch { throw new Error(`failed to parse bounds for ${ref}`); }
  const el = parsed?.data?.value;
  if (getOut.code !== 0 || parsed?.ok === false || !el || !Number.isFinite(el.x) || !Number.isFinite(el.y)) {
    throw new Error(parsed?.error?.message ?? `could not resolve bounds for ${ref}`);
  }

  let winBounds = knownWindowBounds;
  const targetWinId = verifyId ?? argFlagValue(args, '--window-id');
  const targetApp = argFlagValue(args, '--app');
  if (!winBounds && (targetWinId || targetApp)) {
    const listArgs = targetApp ? ['list-windows', '--app', targetApp] : ['list-windows'];
    const listOut = await runner(bin, listArgs, signal);
    try {
      const wins = JSON.parse(listOut.stdout)?.data as { id?: string; is_focused?: boolean; bounds?: Bounds }[] | undefined;
      const match = targetWinId ? wins?.find(w => w.id === targetWinId) : (wins?.find(w => w.is_focused) ?? wins?.[0]);
      winBounds = match?.bounds;
    } catch { /* fall through to screen-relative fallback */ }
  }

  if (!winBounds || winBounds.width <= 0 || winBounds.height <= 0) {
    return el;
  }
  const dims = readPngDimensions(pngBuffer);
  const scaleX = dims && dims.width > 0 ? dims.width / winBounds.width : 1;
  const scaleY = dims && dims.height > 0 ? dims.height / winBounds.height : 1;
  return {
    x: (el.x - winBounds.x) * scaleX,
    y: (el.y - winBounds.y) * scaleY,
    width: el.width * scaleX,
    height: el.height * scaleY,
  };
}

export async function execute(p: Params, signal?: AbortSignal, runner: Runner = run, bin = binaryPath(), windowBounds?: Bounds): Promise<Result> {
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
    let ok = out.code === 0 && (value as { ok?: unknown }).ok !== false;
    let rawImage = shot && existsSync(shot) ? readFileSync(shot) : undefined;
    if (ok && p.verify) {
      dir ??= mkdtempSync(join(tmpdir(), 'pi-agent-desktop-'));
      const after = join(dir, 'after.png');
      await runner(bin, ['screenshot', '--window-id', p.verify, after], signal);
      if (existsSync(after)) rawImage = readFileSync(after);
    }
    let image: string | undefined;
    let imageMimeType: 'image/png' | 'image/jpeg' | undefined;
    if (rawImage) {
      if (p.screenshot) {
        try {
          const resolvedCrop = p.screenshot.ref
            ? await resolveRefCrop(p.screenshot.ref, rawImage, p.args ?? [], p.verify, signal, runner, bin, windowBounds)
            : undefined;
          const processed = processScreenshot(rawImage, p.screenshot, resolvedCrop);
          image = processed.buffer.toString('base64');
          imageMimeType = processed.mimeType;
        } catch (err) {
          ok = false;
          const message = err instanceof Error ? err.message : String(err);
          value = { ok: false, error: { code: 'SCREENSHOT_PROCESS_FAILED', message } };
        }
      } else {
        image = rawImage.toString('base64');
      }
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
    return { value, text, image, imageMimeType, isError: !ok };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}
