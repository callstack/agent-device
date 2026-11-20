import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');

test('packed core discovers vega only after the managed platform is installed', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-vega-pack-'));
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('AGENT_DEVICE_')),
    ),
    AGENT_DEVICE_HOME: path.join(scratch, 'home'),
    AGENT_DEVICE_STATE_DIR: path.join(scratch, 'state'),
    AGENT_DEVICE_CLAIMS_DIR: path.join(scratch, 'claims'),
    AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1',
  };
  // The Vega CLI is a host tool the plugin reads through PATH and through the home's default
  // install. A machine that has it installed would answer its own device list, so every CLI run
  // names a host that carries neither: the installed plugin then always answers its toolchain
  // report, on any machine.
  const cliEnv = {
    ...env,
    PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    HOME: scratch,
  };
  const exec = (command, args, cwd = scratch) =>
    execFileSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
  const cli = (...args) =>
    exec(process.execPath, ['node_modules/agent-device/bin/agent-device.mjs', ...args]);
  const runCli = (expectedExit, ...args) => {
    const invoke = () =>
      execFileSync(
        process.execPath,
        ['node_modules/agent-device/bin/agent-device.mjs', ...args, '--json'],
        { cwd: scratch, env: cliEnv, encoding: 'utf8', timeout: 120_000 },
      );
    try {
      const reply = JSON.parse(invoke());
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
    assert.ok(!packed.files.some(({ path }) => path.includes('/platform-vega/')));
    exec(
      'pnpm',
      ['pack', '--out', path.join(scratch, 'vega.tgz')],
      path.join(repo, 'packages/platform-vega'),
    );
    fs.writeFileSync(path.join(scratch, 'package.json'), '{"private":true}');
    exec('npm', [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      path.join(scratch, packed.filename),
    ]);
    assert.match(cli('help', 'tv'), /agent-device plugins add @agent-device\/vega/);

    const { error } = runCli(1, 'devices', '--platform', 'vega');
    assert.equal(error.details.reason, 'plugin-not-installed');
    assert.match(error.hint, /agent-device plugins add @agent-device\/vega/);
    // An unfiltered discovery request never names a family the core lacks: it skips Vega silently.
    runCli(0, 'devices');
    runCli(0, 'daemon', 'stop');
    runCli(0, 'plugins', 'add', './vega.tgz');
    // The Vega CLI is not installed on this host, so the plugin is active and reports its
    // toolchain instead of an absent plugin.
    const installed = runCli(1, 'devices', '--platform', 'vega');
    assert.equal(installed.error.code, 'TOOL_MISSING');
    const plugins = runCli(0, 'daemon', 'status').data.plugins;
    assert.ok(plugins.some((plugin) => plugin.platform === 'vega' && plugin.state === 'active'));
  } finally {
    try {
      if (fs.existsSync(path.join(scratch, 'node_modules/agent-device')))
        runCli(0, 'daemon', 'stop');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
});
