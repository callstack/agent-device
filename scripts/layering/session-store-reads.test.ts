import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('the raw session read gate rejects an increase outside owners', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-reads-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const route = path.join(cwd, 'packages/daemon/src/core/route.ts');
  fs.mkdirSync(path.dirname(route), { recursive: true });
  fs.writeFileSync(route, 'sessionStore.get(name);\n');
  git('init');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture');

  const run = () =>
    spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        fileURLToPath(new URL('./session-store-reads.ts', import.meta.url)),
      ],
      {
        cwd,
        env: { ...process.env, SESSION_STORE_READ_BASE: 'HEAD' },
        encoding: 'utf8',
      },
    );

  fs.writeFileSync(route.replace('route.ts', 'session-store.ts'), 'sessionStore.get(name);\n');
  fs.writeFileSync(route.replace('route.ts', 'route.test.ts'), 'sessionStore.lookup(name);\n');
  git('add', '.');
  const unchanged = run();
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.match(unchanged.stdout, /1 → 1/);

  fs.appendFileSync(route, 'sessionStore.lookup(name);\n');
  const increased = run();
  assert.equal(increased.status, 1, increased.stderr);
  assert.match(increased.stdout, /1 → 2/);
  assert.match(increased.stderr, /Raw sessionStore reads increased/);
});
