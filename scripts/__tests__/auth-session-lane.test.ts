import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';

function fixture(cli: string) {
  const root = fs.realpathSync(mkdtempForTestSync('agent-device-auth-lane-'));
  for (const dir of ['scripts', 'bin', 'examples/test-app/src', 'examples/test-app/maestro-ios']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  for (const name of ['run-test-app-auth-session-lane.mjs', 'run-test-app-maestro-suite.mjs']) {
    fs.copyFileSync(path.join(import.meta.dirname, '..', name), path.join(root, 'scripts', name));
  }
  for (const name of ['auth-session-sheet.yaml', 'unrelated.yaml']) {
    fs.writeFileSync(path.join(root, 'examples/test-app/maestro-ios', name), '');
  }
  const prelude = "import fs from 'node:fs';\n";
  const source = path.join(import.meta.dirname, '../../examples/test-app/src');
  const fixtureDir = path.join(root, 'examples/test-app/src');
  fs.copyFileSync(
    path.join(source, 'auth-idp-server.mjs'),
    path.join(fixtureDir, 'auth-idp-server.mjs'),
  );
  const page = fs.readFileSync(path.join(source, 'auth-idp-fixture.ts'), 'utf8');
  const ephemeralPage = page.replace('AUTH_IDP_DEFAULT_PORT = 4593', 'AUTH_IDP_DEFAULT_PORT = 0');
  assert.notEqual(ephemeralPage, page);
  fs.writeFileSync(path.join(fixtureDir, 'auth-idp-fixture.ts'), ephemeralPage);
  fs.writeFileSync(path.join(root, 'bin/agent-device.mjs'), prelude + cli);

  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      'scripts/run-test-app-auth-session-lane.mjs',
      '--',
      '--udid',
      'fixture',
    ],
    { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  const exit = once(child, 'close');
  onTestFinished(async () => {
    if (child.kill('SIGKILL')) await exit;
  });
  return {
    root,
    child,
    exit,
    stderr: () => stderr,
    marker: (name: string) => fs.existsSync(path.join(root, name)),
  };
}

test('the lane runs only the sign-in sheet flow and closes its fixture server', async () => {
  const lane = fixture("fs.writeFileSync('argv', JSON.stringify(process.argv.slice(2)));");
  assert.deepEqual(await lane.exit, [0, null], lane.stderr());
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

test.skipIf(process.platform === 'win32')(
  'cancellation closes the fixture server and stops the suite CLI',
  async () => {
    const lane = fixture(
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
    assert.equal(lane.marker('cli-stopped'), true);
  },
  8000,
);
