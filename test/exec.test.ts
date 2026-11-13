import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { beforeEach, test } from 'node:test';
import type { Runner } from '../src/cli.ts';
import { resetCells, runCell } from '../src/exec.ts';

const WINDOWS = [
  { id: 'w-1', app_name: 'WindowsTerminal.exe', title: 'pi', bounds: { x: 0, y: 0, width: 800, height: 600 }, is_focused: true },
  { id: 'w-2', app_name: 'brave.exe', title: 'Google - Brave', bounds: { x: 6, y: 16, width: 1000, height: 800 } },
  { id: 'w-3', app_name: 'brave.exe', title: 'Slack API: Applications - Brave', bounds: { x: -100, y: 10, width: 1000, height: 800 } },
];

/** Fake agent-desktop: records every argv, answers list-windows, writes a PNG for screenshots. */
function desktop(fail?: string) {
  const calls: string[][] = [];
  const runner: Runner = async (_bin, args) => {
    calls.push(args);
    if (args[0] === fail) return { code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'ACTION_FAILED', message: 'nope' } }), stderr: '' };
    if (args[0] === 'list-windows') return { code: 0, stdout: JSON.stringify({ ok: true, data: WINDOWS }), stderr: '' };
    if (args[0] === 'screenshot') writeFileSync(args.at(-1)!, Buffer.from('png'));
    return { code: 0, stdout: '{"ok":true,"data":{}}', stderr: '' };
  };
  return { calls, runner, names: () => calls.map(c => c[0]) };
}

beforeEach(() => resetCells());

test('values assigned in one cell are there in the next', async () => {
  const d = desktop();
  await runCell({ code: 'n = 41' }, undefined, d.runner, 'bin');
  const r = await runCell({ code: 'return n + 1' }, undefined, d.runner, 'bin');
  assert.equal(r.isError, false);
  assert.match(r.text, /=> 42/);
});

test('win picks an app window by name prefix and title, and keys/press go to it', async () => {
  const d = desktop();
  const r = await runCell({ code: 'await win("brave", "slack"); await keys("Ab:"); await press("return"); return W.id' }, undefined, d.runner, 'bin');
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /=> w-3/);
  const presses = d.calls.filter(c => c[0] === 'press');
  assert.deepEqual(presses.map(c => c[1]), ['shift+a', 'b', ':', 'return']);
  assert.ok(presses.every(c => c.join(' ').includes('--window-id w-3')));
  assert.match(r.text, /keys "Ab:" \(3 presses\)/);
});

test('at clicks a point of the window screenshot in desktop coordinates, only when headed', async () => {
  const refused = desktop();
  const r1 = await runCell({ code: 'await win("brave", "slack"); await at(10, 20)' }, undefined, refused.runner, 'bin');
  assert.equal(r1.isError, true);
  assert.match(r1.text, /mouse-click refused, not run: .*headed/);
  assert.ok(!refused.names().includes('mouse-click'));

  const d = desktop();
  const r2 = await runCell({ code: 'await win("brave", "slack"); await at(10, 20)', headed: true }, undefined, d.runner, 'bin');
  assert.equal(r2.isError, false, r2.text);
  assert.deepEqual(d.calls.find(c => c[0] === 'focus-window'), ['focus-window', '--window-id', 'w-3', '--headed']);
  // A negative coordinate stays one token: --xy=-90,30, as the binary requires.
  assert.deepEqual(d.calls.find(c => c[0] === 'mouse-click'), ['mouse-click', '--xy=-90,30', '--headed']);
});

test('an acting cell comes back with a screenshot of its window; an observing one does not', async () => {
  const d = desktop();
  const acting = await runCell({ code: 'await win("brave"); await press("tab")' }, undefined, d.runner, 'bin');
  assert.equal(acting.image, Buffer.from('png').toString('base64'));
  assert.deepEqual(d.calls.at(-1)!.slice(0, 3), ['screenshot', '--window-id', 'w-2']);

  const o = desktop();
  const observing = await runCell({ code: 'await win("brave"); await snap()' }, undefined, o.runner, 'bin');
  assert.equal(observing.image, undefined);
  assert.ok(!o.names().includes('screenshot'));
  // Observing commands never carry --headed, even in a headed cell.
  const h = desktop();
  await runCell({ code: 'await win("brave")', headed: true }, undefined, h.runner, 'bin');
  assert.deepEqual(h.calls[0], ['list-windows']);
});

test('a failing step stops the cell, names the steps that ran and still shows the window', async () => {
  const d = desktop('click');
  const r = await runCell({ code: 'await win("brave"); await press("a"); await click("@e1"); await press("b")' }, undefined, d.runner, 'bin');
  assert.equal(r.isError, true);
  assert.match(r.text, /error: click failed: ACTION_FAILED: nope/);
  assert.match(r.text, /steps: list-windows · press a --window-id w-2 · click @e1 FAILED · screenshot/);
  assert.ok(!d.calls.some(c => c[0] === 'press' && c[1] === 'b'));
  assert.ok(r.image);
});

test('a cell past its timeout returns, and its later desktop calls are refused', async () => {
  const d = desktop();
  const r = await runCell({ code: 'await sleep(1500); await press("x")', timeout: 1 }, undefined, d.runner, 'bin');
  assert.equal(r.isError, true);
  assert.match(r.text, /timed out after 1s/);
  await new Promise(res => setTimeout(res, 700));
  assert.ok(!d.names().includes('press'));
  // Nor can a call made after the cell reported act: every effect is in some cell's steps.
  const late = desktop();
  await runCell({ code: 'sleep(50).then(() => ad("status")).catch(() => {}); return 1' }, undefined, late.runner, 'bin');
  await new Promise(res => setTimeout(res, 200));
  assert.deepEqual(late.names(), []);
});

test('a call the cell started without await finishes before the answer and is listed in its steps', async () => {
  const d = desktop();
  const slow: Runner = async (bin, args, signal) => { await new Promise(res => setTimeout(res, 30)); return d.runner(bin, args, signal); };
  const r = await runCell({ code: 'ad("status"); return 1' }, undefined, slow, 'bin');
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /still running when the cell ended, waited for: status/);
  assert.match(r.text, /steps: status/);
});

test('errors in the code itself come back as text, with nothing run', async () => {
  const d = desktop();
  const r = await runCell({ code: 'await nope()' }, undefined, d.runner, 'bin');
  assert.equal(r.isError, true);
  assert.match(r.text, /ReferenceError: nope is not defined/);
  assert.equal(d.calls.length, 0);
});
