import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { execute, page, plan, type Runner } from '../src/cli.ts';

const fake = (stdout: string, code = 0, onRun?: (args: string[]) => void): Runner => async (_bin, args) => {
  onRun?.(args);
  return { code, stdout, stderr: '' };
};

test('plan defaults to status and passes args verbatim', () => {
  assert.deepEqual(plan({}), { argv: ['status'] });
  assert.deepEqual(plan({ command: 'type', args: ['@e1', 'a; rm -rf /'] }), { argv: ['type', '@e1', 'a; rm -rf /'] });
});

test('plan refuses unknown commands, batch/session and smuggled flags', () => {
  for (const command of ['batch', 'session', 'cursor-overlay', 'rm']) assert.ok('error' in plan({ command }), command);
  assert.ok('error' in plan({ command: 'click', args: ['@e1', '--headed'] }));
  assert.ok('error' in plan({ command: 'snapshot', args: ['--debug'] }));
});

test('physical commands require headed, which appends --headed', () => {
  assert.ok('error' in plan({ command: 'mouse-click', args: ['10', '10'] }));
  assert.deepEqual(plan({ command: 'mouse-click', args: ['10', '10'], headed: true }), { argv: ['mouse-click', '10', '10', '--headed'] });
});

test('a point is accepted as --xy or --x/--y on every pointer command', () => {
  // agent-desktop 1.0.2 takes --x/--y on mouse-wheel and --xy elsewhere; the agent should not need to know which.
  assert.deepEqual(plan({ command: 'mouse-wheel', args: ['--xy', '1323,1043', '--dy', '-6'], headed: true }),
    { argv: ['mouse-wheel', '--x', '1323', '--y', '1043', '--dy', '-6', '--headed'] });
  assert.deepEqual(plan({ command: 'mouse-click', args: ['--x', '899', '--y', '1113'], headed: true }),
    { argv: ['mouse-click', '--xy', '899,1113', '--headed'] });
  assert.deepEqual(plan({ command: 'hover', args: ['--y', '5', '--x', '4'], headed: true }), { argv: ['hover', '--xy', '4,5', '--headed'] });
  // The native form passes through untouched.
  assert.deepEqual(plan({ command: 'mouse-wheel', args: ['--x', '1', '--y', '2', '--dy', '3'], headed: true }),
    { argv: ['mouse-wheel', '--x', '1', '--y', '2', '--dy', '3', '--headed'] });
  assert.deepEqual(plan({ command: 'mouse-move', args: ['--xy', '7,8'], headed: true }), { argv: ['mouse-move', '--xy', '7,8', '--headed'] });
});

test('execute parses JSON and flags ok:false as error', async () => {
  const good = await execute({ command: 'list-apps' }, undefined, fake('{"ok":true,"data":{"apps":[]}}'), 'bin');
  assert.equal(good.isError, false);
  assert.deepEqual(good.value, { ok: true, data: { apps: [] } });
  const bad = await execute({ command: 'click', args: ['@e9'] }, undefined, fake('{"ok":false,"error":{"code":"STALE_REF"}}', 1), 'bin');
  assert.equal(bad.isError, true);
  assert.match(bad.text, /STALE_REF/);
});

test('refused plan never runs the binary', async () => {
  let ran = false;
  const r = await execute({ command: 'drag' }, undefined, fake('{}', 0, () => { ran = true; }), 'bin');
  assert.equal(r.isError, true);
  assert.equal(ran, false);
});

test('screenshot without a path captures to a temp PNG and returns it', async () => {
  let path = '';
  const r = await execute({ command: 'screenshot', args: ['--app', 'x'] }, undefined, fake('{"ok":true}', 0, args => {
    path = args.at(-1)!; writeFileSync(path, Buffer.from('png'));
  }), 'bin');
  assert.match(path, /shot\.png$/);
  assert.equal(r.image, Buffer.from('png').toString('base64'));
});

test('page truncates with a continuation offset', () => {
  const s = 'x'.repeat(25);
  assert.equal(page(s, 0, 30), s);
  assert.match(page(s, 0, 10), /repeat with offset 10/);
  assert.equal(page(s, 20, 10), 'xxxxx');
});

test('snapshot TIMEOUT carries a --max-depth 3 hint', async () => {
  const r = await execute({ command: 'snapshot', args: ['--app', 'Slack.exe', '-i'] }, undefined,
    fake('{"ok":false,"error":{"code":"TIMEOUT","message":"timed out"}}', 1), 'bin');
  assert.equal(r.isError, true);
  assert.match(r.text, /--max-depth 3/);
  const other = await execute({ command: 'click', args: ['@e9'] }, undefined,
    fake('{"ok":false,"error":{"code":"TIMEOUT"}}', 1), 'bin');
  assert.doesNotMatch(other.text, /--max-depth/);
});

test('verify attaches a screenshot of the given window after the action, in the same call', async () => {
  const calls: string[][] = [];
  const r = await execute({ command: 'mouse-click', args: ['--xy', '10,20'], headed: true, verify: 'w-1' }, undefined, async (_b, args) => {
    calls.push(args);
    if (args[0] === 'screenshot') writeFileSync(args.at(-1)!, Buffer.from('after'));
    return { code: 0, stdout: '{"ok":true}', stderr: '' };
  }, 'bin');
  assert.equal(calls[0][0], 'mouse-click');
  assert.deepEqual(calls[1].slice(0, 3), ['screenshot', '--window-id', 'w-1']);
  assert.equal(r.image, Buffer.from('after').toString('base64'));
  assert.equal(r.isError, false);
});

test('verify is skipped when the action failed, and is refused on observing commands', async () => {
  const calls: string[][] = [];
  await execute({ command: 'click', args: ['@e1'], verify: 'w-1' }, undefined, async (_b, args) => { calls.push(args); return { code: 1, stdout: '{"ok":false}', stderr: '' }; }, 'bin');
  assert.equal(calls.length, 1);
  assert.ok('error' in plan({ command: 'snapshot', verify: 'w-1' }));
});

const HELP = 'Capture the tree\n\nUsage: agent-desktop snapshot [OPTIONS]\n\nOptions:\n      --app <APP>            Filter\n      --window-id <window-id>  Scope to a window\n  -i, --interactive-only     Only interactive\n  -h, --help                 Print help\n';
const invalid = (flag: string) => JSON.stringify({ ok: false, command: 'snapshot', error: { code: 'INVALID_ARGS', message: `error: unexpected argument '${flag}' found` } });

test('an unexpected argument comes back with the command\'s real options and the closest one', async () => {
  const calls: string[][] = [];
  const runner: Runner = async (_bin, args) => {
    calls.push(args);
    return args.includes('--help') ? { code: 0, stdout: HELP, stderr: '' } : { code: 2, stdout: invalid('--window'), stderr: '' };
  };
  const r = await execute({ command: 'snapshot', args: ['--window', 'w-1'] }, undefined, runner, 'bin');
  assert.equal(r.isError, true);
  assert.deepEqual(calls.map(c => c.includes('--help')), [false, true]);
  assert.deepEqual(calls[1], ['snapshot', '--help']);
  const hint = String((r.value as { hint?: string }).hint);
  assert.match(hint, /--window-id/);
  assert.match(hint, /Did you mean --window-id\?/);
  assert.match(hint, /--interactive-only/);
});

test('other failures do not trigger a help lookup', async () => {
  const calls: string[][] = [];
  const runner: Runner = async (_bin, args) => { calls.push(args); return { code: 1, stdout: '{"ok":false,"error":{"code":"STALE_REF","message":"unexpected argument \'x\'"}}', stderr: '' }; };
  const r = await execute({ command: 'click', args: ['@e1'] }, undefined, runner, 'bin');
  assert.equal(r.isError, true);
  assert.equal(calls.length, 1);
});
