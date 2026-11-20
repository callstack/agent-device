import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');

test('packed core discovers harmonyos only after the managed platform is installed', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-harmonyos-pack-'));
  // HDC is a host tool the plugin reads through PATH and through the three documented SDK roots.
  // A machine that has it installed would answer with its own device list, so every CLI run names a
  // host that carries neither: the installed plugin then always answers its own missing-toolchain
  // report, on any machine.
  const strippedHost = (source) =>
    Object.fromEntries(
      Object.entries(source).filter(
        ([name]) =>
          !name.startsWith('AGENT_DEVICE_') &&
          !['HDC_SDK_PATH', 'DEVECO_SDK_HOME', 'HARMONYOS_COMMAND_LINE_TOOLS'].includes(name),
      ),
    );
  const env = {
    ...strippedHost(process.env),
    AGENT_DEVICE_HOME: path.join(scratch, 'home'),
    AGENT_DEVICE_STATE_DIR: path.join(scratch, 'state'),
    AGENT_DEVICE_CLAIMS_DIR: path.join(scratch, 'claims'),
    AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1',
  };
  const cliEnv = {
    ...env,
    PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    HOME: scratch,
  };
  const exec = (command, args, cwd = scratch) =>
    execFileSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
  // Help is the CLI's local fast path: it renders text and never takes `--json`.
  const cliText = (...args) =>
    exec(process.execPath, ['node_modules/agent-device/bin/agent-device.mjs', ...args], scratch);
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
    assert.ok(!packed.files.some(({ path }) => path.includes('/platform-harmonyos/')));
    exec(
      'pnpm',
      ['pack', '--out', path.join(scratch, 'harmonyos.tgz')],
      path.join(repo, 'packages/platform-harmonyos'),
    );
    fs.writeFileSync(path.join(scratch, 'package.json'), '{"private":true}');
    exec('npm', [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      path.join(scratch, packed.filename),
    ]);

    // Without the plugin: a request that names the family answers the typed outcome with the
    // install command, an unfiltered request skips the family silently, and help still renders.
    const { error } = runCli(1, 'devices', '--platform', 'harmonyos');
    assert.equal(error.details.reason, 'plugin-not-installed');
    assert.match(error.hint, /agent-device plugins add @agent-device\/harmonyos/);

    const open = runCli(1, 'open', 'com.example.app', '--platform', 'harmonyos');
    assert.equal(open.error.details.reason, 'plugin-not-installed');

    // Doctor names the family's own blocker through a failing toolchain row, built from the same
    // absence outcome the discovery request raises. An unfiltered doctor stays silent about it.
    const scoped = runCli(0, 'doctor', '--platform', 'harmonyos');
    const toolchain = scoped.data.checks.find((check) => check.id === 'toolchain');
    assert.equal(toolchain.status, 'fail');
    assert.equal(toolchain.evidence.reason, 'plugin-not-installed');
    assert.equal(toolchain.evidence.package, '@agent-device/harmonyos');
    assert.match(toolchain.command, /agent-device plugins add @agent-device\/harmonyos/);
    const unscoped = runCli(0, 'doctor');
    assert.ok(
      !unscoped.data.checks.some((check) =>
        JSON.stringify(check).includes('@agent-device/harmonyos'),
      ),
      'an unfiltered doctor names no plugin the core lacks',
    );
    runCli(0, 'devices');
    // The family's help renders with no plugin installed: nothing about HarmonyOS depends on it.
    assert.match(cliText('help', 'devices'), /devices/);
    runCli(0, 'daemon', 'stop');

    runCli(0, 'plugins', 'add', './harmonyos.tgz');
    // HDC is not installed on this host, so the plugin is active and reports its own toolchain
    // rather than an absent plugin.
    const installed = runCli(1, 'devices', '--platform', 'harmonyos');
    assert.equal(installed.error.code, 'TOOL_MISSING');
    const plugins = runCli(0, 'daemon', 'status').data.plugins;
    assert.ok(
      plugins.some((plugin) => plugin.platform === 'harmonyos' && plugin.state === 'active'),
    );
  } finally {
    try {
      if (fs.existsSync(path.join(scratch, 'node_modules/agent-device')))
        runCli(0, 'daemon', 'stop');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
});
