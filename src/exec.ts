import { createContext, runInContext, type Context } from 'node:vm';
import { binaryPath, execute, OBSERVE, page, plan, run, type Result, type Runner } from './cli.ts';

/** One `exec` call: the body of an async JavaScript function run with the desktop helpers. */
export interface CellParams { code?: string; headed?: boolean; timeout?: number; offset?: number; limit?: number }

interface Win { id: string; app_name: string; title: string; bounds: { x: number; y: number; width: number; height: number }; is_focused?: boolean; minimized?: boolean }

const KEY_NAMES: Record<string, string> = { ' ': 'space', '\n': 'return', '\t': 'tab' };

class CellError extends Error {}

/** Variables a cell assigns without let/const live here until the session ends. */
let context: Context | undefined;

export function resetCells(): void { context = undefined; }

const show = (v: unknown) => typeof v === 'string' ? v : JSON.stringify(v);

function failure(value: unknown): string {
  const err = (value as { error?: unknown }).error;
  const e = typeof err === 'object' && err ? err as { code?: string; message?: string } : { message: String(err ?? 'failed') };
  const hint = (value as { hint?: string }).hint;
  return [e.code, e.message].filter(Boolean).join(': ') + (hint ? ` (${hint})` : '');
}

export async function runCell(p: CellParams, signal?: AbortSignal, runner: Runner = run, bin = binaryPath()): Promise<Result> {
  if (!p.code?.trim()) {
    const error = 'exec needs code: the body of an async JavaScript function.';
    return { value: { ok: false, error }, text: JSON.stringify({ ok: false, error }), isError: true };
  }
  context ??= createContext({});
  const ctx = context as Record<string, unknown>;
  const seconds = Math.min(Math.max(p.timeout ?? 30, 1), 300);
  const deadline = Date.now() + seconds * 1000;
  const logs: string[] = [], steps: string[] = [];
  let image: string | undefined, acted = false, shotAfterAct = false, closed = false;
  /** Calls in flight, so a cell that forgot an await still reports every effect it started. */
  const running = new Map<Promise<unknown>, string>();
  const call = (command: string, args: unknown[], record = true): Promise<unknown> => {
    const c = step(command, args, record);
    running.set(c, [command, ...args].join(' '));
    c.then(() => running.delete(c), () => running.delete(c));
    return c;
  };

  /** Runs one agent-desktop command; throws on refusal or failure so the cell stops at the first error. */
  const step = async (command: string, args: unknown[], record: boolean): Promise<unknown> => {
    if (closed) throw new CellError('this cell already ended; its later desktop calls are refused');
    if (signal?.aborted || Date.now() > deadline) throw new CellError(`cell stopped (timeout ${seconds}s or abort) before ${command}`);
    const observe = OBSERVE.has(command);
    const params = { command, args: args.map(String), headed: observe ? undefined : p.headed, limit: Number.MAX_SAFE_INTEGER };
    const planned = plan(params);
    if ('error' in planned) throw new CellError(`${command} refused, not run: ${planned.error}`);
    const r = await execute(params, signal, runner, bin);
    if (!observe) { acted = true; shotAfterAct = false; }
    if (record) steps.push(`${command} ${params.args.join(' ')}`.trim() + (r.isError ? ' FAILED' : ''));
    if (r.isError) throw new CellError(`${command} failed: ${failure(r.value)}`);
    if (r.image) { image = r.image; if (acted) shotAfterAct = true; }
    const v = r.value as { data?: unknown };
    return v && typeof v === 'object' && 'data' in v ? v.data : v;
  };
  const current = (): Win => {
    const w = ctx.W as Win | undefined;
    if (!w?.id) throw new CellError('no window selected: call win(app) first');
    return w;
  };
  const target = () => ctx.W ? ['--window-id', current().id] : [];
  const point = (x: number, y: number) => { const b = current().bounds; return [Math.round(b.x + x), Math.round(b.y + y)]; };

  Object.assign(ctx, {
    console: { log: (...a: unknown[]) => { logs.push(a.map(show).join(' ')); } },
    print: (...a: unknown[]) => { logs.push(a.map(show).join(' ')); },
    sleep: (ms: number) => new Promise(r => setTimeout(r, ms)),
    ad: (command: string, ...args: unknown[]) => call(command, args),
    win: async (app: string, title?: string) => {
      const list = await call('list-windows', []) as Win[];
      const a = app.toLowerCase(), t = title?.toLowerCase();
      const found = list.filter(w => !w.minimized && w.app_name.toLowerCase().startsWith(a) && (!t || w.title.toLowerCase().includes(t)));
      const w = found.find(w => w.is_focused) ?? found[0];
      if (!w) throw new CellError(`no visible window of "${app}"${title ? ` titled "${title}"` : ''}; open: ${[...new Set(list.map(w => w.app_name))].join(', ')}`);
      ctx.W = w;
      return w;
    },
    snap: (...args: unknown[]) => call('snapshot', [...target(), '-i', ...args]),
    find: (...args: unknown[]) => call('find', [...target(), ...args]),
    click: (ref: string) => call('click', [ref]),
    type: (ref: string, text: string) => call('type', [ref, text]),
    // Keys always name their window: without one they would land in whatever the operator has focused.
    press: (combo: string) => call('press', [combo, '--window-id', current().id]),
    keys: async (text: string) => {
      const id = current().id;
      for (const ch of text) {
        const key = KEY_NAMES[ch] ?? (/[A-Z]/.test(ch) ? `shift+${ch.toLowerCase()}` : ch);
        await call('press', [key, '--window-id', id], false);
      }
      steps.push(`keys ${JSON.stringify(text)} (${[...text].length} presses)`);
    },
    at: async (x: number, y: number) => {
      const [X, Y] = point(x, y);
      await call('focus-window', ['--window-id', current().id]);
      return call('mouse-click', [`--xy=${X},${Y}`]);
    },
    wheel: async (dy: number, x?: number, y?: number) => {
      const b = current().bounds;
      const [X, Y] = point(x ?? b.width / 2, y ?? b.height / 2);
      return call('mouse-wheel', [`--x=${X}`, `--y=${Y}`, `--dy=${dy}`]);
    },
    shot: async () => { await call('screenshot', target()); return 'screenshot attached'; },
  });

  let ret: unknown, error: string | undefined, timer: NodeJS.Timeout | undefined, live = false;
  try {
    const fn = runInContext(`(async () => {\n${p.code}\n})`, context, { filename: 'desktop-cell.js' }) as () => Promise<unknown>;
    const timedOut = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new CellError(`cell timed out after ${seconds}s`)), deadline - Date.now()); });
    live = true;
    ret = await Promise.race([fn().finally(() => { live = false; }), timedOut]);
  } catch (e) {
    error = e instanceof Error ? (e instanceof CellError ? e.message : `${e.name}: ${e.message}`) : String(e);
  } finally {
    clearTimeout(timer);
    closed = true;
  }
  // Code still running past the timeout looks helpers up in its own context: dropping that context
  // leaves it with this ended cell's helpers, which refuse, instead of the next cell's.
  if (live) {
    if (context === ctx) context = undefined;
    logs.push('note: the code was still running at the timeout, so the cell variables were dropped and it cannot act later');
  }
  // Calls the cell started but never awaited still finish here, so the answer lists every effect.
  if (running.size) {
    const left = [...running.values()];
    await Promise.allSettled([...running.keys()]);
    logs.push(`note: still running when the cell ended, waited for: ${left.join(", ")}`);
  }
  // An acting cell answers with what the window looks like now, so the agent never has to guess whether input landed.
  const w = ctx.W as Win | undefined;
  if (acted && !shotAfterAct && w?.id) {
    const after = await execute({ command: 'screenshot', args: ['--window-id', w.id] }, undefined, runner, bin);
    if (after.image) { image = after.image; steps.push(`screenshot --window-id ${w.id} (after)`); }
  }
  const lines = [...logs];
  if (ret !== undefined) lines.push(`=> ${show(ret)}`);
  if (steps.length) lines.push(`steps: ${steps.join(' · ')}`);
  if (error) lines.push(`error: ${error}`);
  return { value: { ok: !error, value: ret, steps, error }, text: page(lines.join('\n') || 'ok (no output)', p.offset, p.limit), image, isError: !!error };
}
