import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const cases = [
  ['allow-list', '!COMMANDS.includes(command)', 'false', 'plan refuses unknown commands'],
  ['headed', 'PHYSICAL.has(command) && !p.headed', 'false', 'physical commands require headed'],
  ['headed-flag', "args.includes('--headed')", 'false', 'plan refuses unknown commands'],
  ['debug-flag', "args.includes('--debug')", 'false', 'plan refuses unknown commands'],
  ['page-offset', 'text.slice(offset, offset + limit)', 'text.slice(0, limit)', 'page truncates'],
  ['observe-verify', 'p.verify !== undefined && OBSERVE.has(command)', 'false', 'verify is skipped'],
  ['verify-success', 'if (ok && p.verify)', 'if (p.verify)', 'verify is skipped'],
  ['cell-closed', "if (closed) throw", 'if (false) throw', 'past its timeout', 'exec'],
  ['cell-headed-observe', 'headed: observe ? undefined : p.headed', 'headed: p.headed', 'acting cell comes back', 'exec'],
  ['cell-refusal', "if ('error' in planned) throw", "if (false) throw", 'only when headed', 'exec'],
  ['cell-after-shot', 'if (acted && !shotAfterAct && w?.id)', 'if (false)', 'acting cell comes back', 'exec'],
  ['cell-offset-reads', 'if (p.offset) return readOn(p, p.offset);', '', 'offset reads on', 'exec'],
  ['cell-offset-other-code', 'if (p.code?.trim() && p.code !== last.code)', 'if (false)', 'offset without a matching', 'exec'],
  ['cell-offset-past-end', 'if (offset >= last.output.length)', 'if (false)', 'offset without a matching', 'exec'],
  ['cell-steps-after-cut', "[...paged, ...summary].join('\\n')", "page([...lines, ...summary].join('\\n'), 0, p.limit, READS_ON)", 'cut before the steps', 'exec'],
];

for (const [name, before, after, pattern, file = 'cli'] of cases) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-desktop-mutant-'));
  try {
    cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });
    cpSync(join(root, 'test'), join(dir, 'test'), { recursive: true });
    cpSync(join(root, 'package.json'), join(dir, 'package.json'));
    symlinkSync(resolve(root, 'node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const path = join(dir, `src/${file}.ts`);
    const source = readFileSync(path, 'utf8');
    assert.equal(source.split(before).length, 2, `unique mutation ${name}`);
    writeFileSync(path, source.replace(before, after));
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', `--test-name-pattern=${pattern}`, `test/${file}.test.ts`], { cwd: dir, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.error, undefined, `${name}: process must run, not time out`);
    assert.notEqual(result.status, 0, `${name}: survived`);
    assert.match(result.stdout + result.stderr, /AssertionError/, `${name}: must fail an assertion, not crash`);
    console.log(`${name}: killed by assertion`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`${cases.length}/${cases.length} boundary mutants killed; disposable copies only`);
