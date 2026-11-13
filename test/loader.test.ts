import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';

test('Pi loads the package: desktop tool and skill are discoverable, status runs the real binary', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pi-agent-desktop-'));
  try {
    const agent = join(home, 'agent'), cwd = join(home, 'project');
    mkdirSync(agent); mkdirSync(cwd);
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({ packages: [fileURLToPath(new URL('../', import.meta.url))] }));
    const loader = new DefaultResourceLoader({ cwd, agentDir: agent, disabledBuiltinExtensions: ['mcp'], noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.ok(loader.getSkills().skills.some(s => s.name === 'pi-agent-desktop'));
    const tool = loaded.extensions.find(e => e.tools.has('desktop'))?.tools.get('desktop')?.definition;
    assert.ok(tool);
    const res = await tool.execute('t', { command: 'version' }, undefined, undefined, {} as never);
    assert.equal(res.isError, false, JSON.stringify(res.content));
    assert.match((res.content[0] as { text: string }).text, /version/);
    const cell = await tool.execute('t', { command: 'exec', code: 'v = await ad("version"); return typeof v' }, undefined, undefined, {} as never);
    assert.equal(cell.isError, false, JSON.stringify(cell.content));
    assert.match((cell.content[0] as { text: string }).text, /=> object\nsteps: version/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
