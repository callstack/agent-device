import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { macosHelperPackFailures } from '../../../scripts/lib/macos-helper-pack.mjs';

const repo = path.resolve(import.meta.dirname, '../../..');

/**
 * A stand-in for the Swift helper the plugin builds on a user's Mac. It answers each helper command
 * with one canned reply in the helper's own JSON envelope and appends its argv to a log, so the test
 * can prove which helper commands the installed plugin sent. Building the real helper needs a Swift
 * toolchain and several minutes; the override variable the plugin reads is the supported way to name
 * another binary.
 */
function helperStubSource(logFile) {
  const tree = {
    surface: 'desktop',
    nodes: [
      {
        index: 0,
        type: 'Window',
        label: 'Stub Window',
        rect: { x: 0, y: 0, width: 400, height: 300 },
        enabled: true,
        hittable: true,
        depth: 0,
      },
      {
        index: 1,
        type: 'Button',
        label: 'OK',
        rect: { x: 40, y: 80, width: 60, height: 30 },
        enabled: true,
        hittable: true,
        depth: 1,
        parentIndex: 0,
      },
    ],
    truncated: false,
    backend: 'macos-helper',
  };
  return [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(logFile)}, args.join(' ') + '\\n');`,
    String.raw`const reply = (data) => process.stdout.write(JSON.stringify({ ok: true, data }) + "\n");`,
    'const value = (flag) => args[args.indexOf(flag) + 1];',
    `if (args[0] === 'snapshot') reply(${JSON.stringify(tree)});`,
    "else if (args[0] === 'screenshot') {",
    "  fs.writeFileSync(value('--out'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));",
    "  reply({ path: value('--out'), surface: 'desktop' });",
    '} else reply({});',
  ].join('\n');
}

test('packed core serves macOS desktop automation only after the managed platform is installed', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-macos-pack-'));
  const strippedHost = (source) =>
    Object.fromEntries(
      Object.entries(source).filter(([name]) => !name.startsWith('AGENT_DEVICE_')),
    );
  const env = {
    ...strippedHost(process.env),
    AGENT_DEVICE_HOME: path.join(scratch, 'home'),
    AGENT_DEVICE_STATE_DIR: path.join(scratch, 'state'),
    AGENT_DEVICE_CLAIMS_DIR: path.join(scratch, 'claims'),
    AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1',
  };
  const exec = (command, args, cwd = scratch) =>
    execFileSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180_000 });
  const cliText = (...args) =>
    exec(process.execPath, ['node_modules/agent-device/bin/agent-device.mjs', ...args], scratch);
  const runCliWith = (environment, expectedExit, ...args) => {
    const invoke = () =>
      execFileSync(
        process.execPath,
        ['node_modules/agent-device/bin/agent-device.mjs', ...args, '--json'],
        {
          cwd: scratch,
          env: environment,
          encoding: 'utf8',
          timeout: 180_000,
          maxBuffer: 32 * 1024 * 1024,
        },
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
  const runCli = (expectedExit, ...args) => runCliWith(env, expectedExit, ...args);
  try {
    // The packed core carries no macOS desktop implementation and no Swift helper. The shared
    // XCTest runner's macOS parts stay in the core by decision (#4675).
    const [packed] = JSON.parse(
      exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], repo),
    );
    const corePaths = packed.files.map(({ path: file }) => file);
    assert.deepEqual(
      corePaths.filter((file) => /(?:^|\/)(?:platform-macos|macos-helper)(?:\/|$)/.test(file)),
      [],
    );
    exec(
      'pnpm',
      ['pack', '--out', path.join(scratch, 'macos.tgz')],
      path.join(repo, 'packages/platform-macos'),
    );
    // The Swift helper ships with the plugin as buildable source and is resolved relative to it. A
    // tarball without its manifest, its sources or a test target's pack stub installs and then fails
    // on the first macOS command, so it is checked where it is packed.
    const packedPlugin = exec('tar', ['tzf', path.join(scratch, 'macos.tgz')])
      .split('\n')
      .filter(Boolean)
      .map((file) => file.replace(/^package\//, ''));
    assert.ok(packedPlugin.includes('dist/agent-device.mjs'), packedPlugin.join('\n'));
    assert.deepEqual(
      macosHelperPackFailures(
        packedPlugin,
        fs.readFileSync(
          path.join(repo, 'packages/platform-macos/macos-helper/Package.swift'),
          'utf8',
        ),
      ),
      [],
    );
    fs.writeFileSync(path.join(scratch, 'package.json'), '{"private":true}');
    exec('npm', [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      path.join(scratch, packed.filename),
    ]);
    // The installed core carries the leaf's absence, not its implementation.
    const installedCore = path.join(scratch, 'node_modules/agent-device');
    assert.equal(fs.existsSync(path.join(installedCore, 'apple/macos-helper')), false);

    // Without the plugin: a request that names macOS answers the typed outcome with the install
    // command, an unfiltered request skips this Mac silently, and help still renders.
    const { error } = runCli(1, 'devices', '--platform', 'macos');
    assert.equal(error.details.reason, 'plugin-not-installed');
    assert.equal(error.details.package, '@agent-device/macos');
    assert.match(error.hint, /agent-device plugins add @agent-device\/macos/);

    const open = runCli(1, 'open', 'TextEdit', '--platform', 'macos');
    assert.equal(open.error.details.reason, 'plugin-not-installed');

    assert.match(cliText('help', 'devices'), /devices/);
    runCli(0, 'daemon', 'stop');

    runCli(0, 'plugins', 'add', './macos.tgz');
    // A daemon started before the store changed cannot see the new entry.
    runCli(0, 'daemon', 'stop');

    // The bundled Apple owner still discovers; with the leaf installed it lists this host's Mac.
    const found = runCli(0, 'devices', '--platform', 'macos');
    assert.equal(found.data.devices.length, 1, JSON.stringify(found.data));
    assert.equal(found.data.devices[0].platform, 'macos');
    assert.equal(found.data.devices[0].id, 'host-macos-local');
    assert.equal(found.data.devices[0].target, 'desktop');
    const plugins = runCli(0, 'daemon', 'status').data.plugins;
    assert.ok(
      plugins.some(
        (plugin) =>
          plugin.platform === 'apple' && plugin.appleOs === 'macos' && plugin.state === 'active',
      ),
      JSON.stringify(plugins),
    );
    runCli(0, 'daemon', 'stop');

    // A macOS session is this Mac's own desktop, so everything below needs a macOS host. The
    // installed plugin then drives a whole desktop interaction through its helper. The native app
    // backend keeps the run off the XCTest runner, which this check does not build.
    if (process.platform !== 'darwin') return;

    const helperCalls = path.join(scratch, 'helper-calls.log');
    const helperStub = path.join(scratch, 'agent-device-macos-helper');
    fs.writeFileSync(helperStub, helperStubSource(helperCalls), 'utf8');
    fs.chmodSync(helperStub, 0o755);
    const desktopEnv = {
      ...env,
      AGENT_DEVICE_MACOS_HELPER_BIN: helperStub,
      AGENT_DEVICE_MACOS_APP_BACKEND: 'native',
    };
    const desktop = ['--platform', 'macos', '--session', 'macos-pack'];

    runCliWith(desktopEnv, 0, 'open', '--surface', 'desktop', ...desktop);
    const captured = runCliWith(desktopEnv, 0, 'snapshot', ...desktop);
    assert.deepEqual(
      captured.data.nodes.map((node) => node.label),
      ['Stub Window', 'OK'],
      JSON.stringify(captured.data.nodes),
    );
    const shot = path.join(scratch, 'screen.png');
    const shotResult = runCliWith(desktopEnv, 0, 'screenshot', shot, ...desktop);
    assert.equal(shotResult.data.path, shot);
    assert.deepEqual([...fs.readFileSync(shot).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    // A desktop session inspects; acting on it is refused by policy before any helper call.
    const refused = runCliWith(desktopEnv, 1, 'press', '42', '84', ...desktop);
    assert.equal(refused.error.code, 'UNSUPPORTED_OPERATION');
    runCliWith(desktopEnv, 0, 'close', ...desktop);

    // The helper commands the plugin sent, in order, among whatever else the session asked it.
    const calls = fs.readFileSync(helperCalls, 'utf8').split('\n').filter(Boolean);
    const expected = ['snapshot --surface desktop', `screenshot --out ${shot} --surface desktop`];
    let cursor = 0;
    for (const call of calls) {
      if (call === expected[cursor]) cursor += 1;
    }
    assert.equal(
      cursor,
      expected.length,
      `the helper did not receive the desktop route. Expected in order: ${JSON.stringify(
        expected,
        null,
        2,
      )} Got: ${JSON.stringify(calls, null, 2)}`,
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
