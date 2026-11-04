import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

test('agent recipes expose the same verification and guard mutations as CI', () => {
  const { checks } = json('../.pi/checks.json');
  const { scripts } = json('../package.json');
  assert.deepEqual(checks.verify.argv, ['node', '--run', 'verify']);
  assert.equal(scripts.verify, 'npm run check && npm test');
  assert.deepEqual(checks.mutations.argv, ['node', ...scripts.mutations.split(' ').slice(1)]);
  assert.deepEqual(checks.module.argv, ['node', '--import', 'tsx', '--test', 'test/cli.test.ts']);
  assert.ok(checks.module.timeoutMs > 0);
  for (const check of Object.values(checks) as { description: string }[]) {
    assert.match(check.description, /offline/i);
  }
});
