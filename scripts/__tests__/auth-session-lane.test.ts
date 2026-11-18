import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';

function fixture(provider: string, cli: string) {
  const root = fs.realpathSync(mkdtempForTestSync('agent-device-auth-lane-'));
  for (const dir of [
    'scripts',
    'bin',
    'examples/test-app/scripts',
    'examples/test-app/maestro-ios',
  ]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  for (const name of ['run-test-app-auth-session-lane.mjs', 'run-test-app-maestro-suite.mjs']) {
    fs.copyFileSync(path.join(import.meta.dirname, '..', name), path.join(root, 'scripts', name));
  }
  for (const name of ['auth-session-sheet.yaml', 'unrelated.yaml']) {
    fs.writeFileSync(path.join(root, 'examples/test-app/maestro-ios', name), '');
  }
  const prelude = "import fs from 'node:fs';\n";
  fs.writeFileSync(
    path.join(root, 'examples/test-app/scripts/serve-auth-idp.mjs'),
    prelude + provider,
  );
  fs.writeFileSync(path.join(root, 'bin/agent-device.mjs'), prelude + cli);

  const child = spawn(
    process.execPath,
    ['scripts/run-test-app-auth-session-lane.mjs', '--', '--udid', 'fixture'],
    { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  const exit = once(child, 'close');
  return {
    root,
    child,
    exit,
    stderr: () => stderr,
    marker: (name: string) => fs.existsSync(path.join(root, name)),
  };
}

const ready = `
  fs.writeSync(1, '[auth-idp] http://fixture\\n');
  process.on('SIGTERM', () => {
    fs.writeFileSync('provider-stopped', '');
    process.exit(0);
  });
`;

test('the selected auth flow can finish while the provider writes more than a pipe buffer', async () => {
  const lane = fixture(
    ready +
      `
      const pump = setInterval(() => {
        if (!fs.existsSync('cli-started')) return;
        clearInterval(pump);
        const chunk = Buffer.alloc(65536, 120);
        for (let i = 0; i < 128; i++) fs.writeSync(1, chunk);
        fs.writeFileSync('provider-drained', '');
      }, 10);
      setTimeout(() => process.exit(9), 5000);
    `,
    `
      fs.writeFileSync('argv', JSON.stringify(process.argv.slice(2)));
      fs.writeFileSync('cli-started', '');
      const probe = setInterval(() => {
        if (fs.existsSync('provider-drained')) process.exit(0);
      }, 10);
      setTimeout(() => { console.error('provider pipe did not drain'); process.exit(7); }, 3000);
    `,
  );
  assert.deepEqual(await lane.exit, [0, null], lane.stderr());
  assert.equal(lane.marker('provider-stopped'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lane.root, 'argv'), 'utf8')), [
    '--session',
    'test-app-maestro',
    'test',
    path.join(lane.root, 'examples/test-app/maestro-ios/auth-session-sheet.yaml'),
    '--maestro',
    '--platform',
    'ios',
    '--udid',
    'fixture',
  ]);
});

test('an early provider failure prevents the suite from starting', async () => {
  const lane = fixture('process.exit(3);', "fs.writeFileSync('cli-started', '');");
  assert.deepEqual(await lane.exit, [1, null], lane.stderr());
  assert.equal(lane.marker('cli-started'), false);
});

test('a failed suite stops the provider', async () => {
  const lane = fixture(ready + 'setTimeout(() => process.exit(9), 5000);', 'process.exit(7);');
  assert.deepEqual(await lane.exit, [1, null], lane.stderr());
  assert.equal(lane.marker('provider-stopped'), true);
});

test.skipIf(process.platform === 'win32')(
  'cancellation stops the provider and the suite CLI',
  async () => {
    const lane = fixture(
      ready + 'setTimeout(() => process.exit(9), 5000);',
      `
      process.on('SIGTERM', () => {
        fs.writeFileSync('cli-stopped', '');
        process.exit(0);
      });
      fs.writeFileSync('cli-started', '');
      setTimeout(() => process.exit(8), 5000);
    `,
    );
    try {
      await expect.poll(() => lane.marker('cli-started')).toBe(true);
    } finally {
      lane.child.kill('SIGTERM');
    }
    assert.deepEqual(await lane.exit, [1, null], lane.stderr());
    assert.equal(lane.marker('provider-stopped'), true);
    assert.equal(lane.marker('cli-stopped'), true);
  },
  8000,
);
