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
