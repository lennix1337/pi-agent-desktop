// Real-desktop smoke: opens a disposable Notepad, types, reads it back, screenshots, closes it.
// Run on a desktop session only: node --import tsx scripts/e2e-notepad.ts
import assert from 'node:assert/strict';
import { execute } from '../src/cli.ts';

const d = async (command: string, args: string[] = [], headed = false) => {
  const r = await execute({ command, args, headed, limit: 100000 });
  console.log(command, r.isError ? 'ERR' : 'ok', r.image ? `png ${r.image.length}b64` : '', r.text.slice(0, 200));
  return r;
};
const data = (r: { value: unknown }) => (r.value as { data: any }).data;

const before = new Set(data(await d('list-windows', ['--app', 'Notepad.exe'])).map?.((w: any) => w.id) ?? []);
assert.equal((await d('launch', ['notepad', '--activate'])).isError, false);
let win: any;
for (let i = 0; i < 20 && !win; i++) {
  win = data(await d('list-windows', ['--app', 'Notepad.exe'])).find?.((w: any) => !before.has(w.id));
  if (!win) await new Promise(r => setTimeout(r, 500));
}
assert.ok(win, 'new Notepad window');
const marker = `pi-agent-desktop ${Date.now()}`;
const found = data(await d('find', ['--app', 'Notepad.exe', '--window-id', win.id, '--role', 'textfield']));
const ref = (Array.isArray(found) ? found : found.matches ?? found.elements)[0].ref_id;
assert.equal((await d('set-value', [ref, marker])).isError, false);
const value = await d('get', [ref]);
assert.match(value.text, new RegExp(marker));
const shot = await d('screenshot', ['--window-id', win.id]);
assert.ok(shot.image && shot.image.length > 1000, 'screenshot image');
await d('close-app', ['Notepad.exe', '--force']);
console.log('E2E PASS');
