import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..');

test('the packed CLI loads React DevTools from its npm installation on demand', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-react-devtools-'));
  try {
    const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8' });
    const [core] = JSON.parse(
      run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], root),
    );
    const devtools = path.join(scratch, 'react-devtools.tgz');
    run('pnpm', ['pack', '--out', devtools], path.join(root, 'packages/react-devtools'));

    const consumer = path.join(scratch, 'consumer');
    fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, 'package.json'), '{"private":true}');
    const install = (tarball) =>
      run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], consumer);
    install(path.join(scratch, core.filename));

    const stateDir = path.join(scratch, 'state');
    const cli = path.join(consumer, 'node_modules/agent-device/bin/agent-device.mjs');
    const invoke = (...args) =>
      spawnSync(process.execPath, [cli, ...args], {
        cwd: scratch,
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENT_DEVICE_HOME: path.join(scratch, 'home'),
          AGENT_DEVICE_STATE_DIR: stateDir,
          AGENT_DEVICE_NO_UPDATE: '1',
        },
      });
    const absent = invoke('react-devtools', 'profile', 'commit', '--json');
    assert.equal(absent.status, 1, absent.stderr);
    const { error } = JSON.parse(absent.stdout);
    assert.equal(error.code, 'TOOL_MISSING');
    assert.equal(error.details.reason, 'plugin-not-installed');
    assert.equal(error.details.package, '@agent-device/react-devtools');
    const installCommand = error.details.installCommand;
    assert.match(installCommand, /^npm install @agent-device\/react-devtools(?:@\S+)?$/);
    assert.ok(invoke('help', 'react-devtools').stdout.includes(installCommand));

    install(devtools);
    const profileDir = path.join(stateDir, 'react-profiles');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, 'qa.json'),
      JSON.stringify({
        version: 2,
        savedAt: '2026-10-16T00:00:00.000Z',
        profile: {
          startedAt: 0,
          stoppedAt: 1000,
          naming: 'operations',
          elements: {},
          keys: [],
          commits: [],
        },
        propKinds: {},
        notes: [],
      }),
    );
    const installed = invoke('react-devtools', 'profile', 'commit', '--session', 'qa', '--json');
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    assert.deepEqual(JSON.parse(installed.stdout), { success: true, data: { commits: [] } });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
