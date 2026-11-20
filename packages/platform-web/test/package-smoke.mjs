import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { installFakeManagedAgentBrowser } from '@agent-device/test-kit';

const repo = path.resolve(import.meta.dirname, '../../..');

test('packed core discovers web only after the managed platform is installed', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-web-pack-'));
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('AGENT_DEVICE_')),
    ),
    AGENT_DEVICE_HOME: path.join(scratch, 'home'),
    AGENT_DEVICE_STATE_DIR: path.join(scratch, 'state'),
    AGENT_DEVICE_CLAIMS_DIR: path.join(scratch, 'claims'),
    AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1',
  };
  const exec = (command, args, cwd = scratch) =>
    execFileSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
  const cli = (...args) =>
    exec(process.execPath, ['node_modules/agent-device/bin/agent-device.mjs', ...args]);
  const runCli = (expectedExit, ...args) => {
    try {
      const reply = JSON.parse(cli(...args, '--json'));
      assert.equal(expectedExit, 0);
      return reply;
    } catch (error) {
      if (expectedExit !== 0 && error.status === expectedExit) return JSON.parse(error.stdout);
      throw error;
    }
  };
  try {
    const [packed] = JSON.parse(
      exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], repo),
    );
    assert.ok(!packed.files.some(({ path }) => path.includes('/agent-browser-provider.')));
    exec(
      'pnpm',
      ['pack', '--out', path.join(scratch, 'web.tgz')],
      path.join(repo, 'packages/platform-web'),
    );
    fs.writeFileSync(path.join(scratch, 'package.json'), '{"private":true}');
    exec('npm', [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      path.join(scratch, packed.filename),
    ]);
    assert.match(cli('help', 'web'), /agent-device plugins add @agent-device\/web/);

    for (const args of [
      ['web', 'setup'],
      ['web', 'doctor'],
      ['devices', '--platform', 'web'],
    ]) {
      const { error } = runCli(1, ...args);
      assert.equal(error.details.reason, 'plugin-not-installed');
      assert.match(error.hint, /agent-device plugins add @agent-device\/web/);
    }
    runCli(0, 'daemon', 'stop');
    if (Number(process.versions.node.split('.')[0]) < 24) {
      assert.equal(
        runCli(1, 'plugins', 'add', './web.tgz').error.details.reason,
        'node-below-floor',
      );
      return;
    }
    runCli(0, 'plugins', 'add', './web.tgz');
    assert.match(
      JSON.stringify(runCli(0, 'devices', '--platform', 'web').data),
      /agent-browser-chrome/,
    );
    const plugins = runCli(0, 'daemon', 'status').data.plugins;
    assert.ok(plugins.some((plugin) => plugin.platform === 'web' && plugin.state === 'active'));
    installFakeManagedAgentBrowser(env.AGENT_DEVICE_STATE_DIR);
    assert.equal(runCli(0, 'web', 'doctor').data.status.installed, true);
  } finally {
    try {
      if (fs.existsSync(path.join(scratch, 'node_modules/agent-device')))
        runCli(0, 'daemon', 'stop');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
});
