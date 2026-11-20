import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');

/**
 * A stand-in for the HarmonyOS HDC toolchain, installed into a directory that is the only
 * `HDC_SDK_PATH` root the plugin is told about. It answers the commands this family asks a target,
 * and appends every invocation to `logFile` so the test can prove which executable ran and with what
 * `PATH`. The log path is baked in rather than passed by environment: the plugin builds each spawn
 * environment from the host it was set up with, so nothing this fixture needs travels through it.
 */
function hdcStubSource(logFile) {
  return [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    'const joined = args.join(" ");',
    'fs.appendFileSync(' +
      JSON.stringify(logFile) +
      String.raw`, "ARGS: " + joined + "\nPATH: " + process.env.PATH + "\n");`,
    String.raw`const answer = (text) => process.stdout.write(text + "\n");`,
    'const LAYOUT = JSON.stringify({',
    '  attributes: { type: "root", bounds: "[0,0][1080,2340]" },',
    '  children: [',
    '    {',
    '      attributes: {',
    '        type: "Button",',
    '        text: "Continue",',
    '        clickable: "true",',
    '        bounds: "[84,1127][1172,1295]",',
    '      },',
    '    },',
    '  ],',
    '});',
    'if (joined.includes("list targets")) answer("stub-target");',
    'else if (joined.includes("const.product.name")) answer("StubPhone");',
    'else if (joined.includes("const.build.characteristics")) answer("default");',
    'else if (joined.includes("bm dump -n"))',
    '  answer(JSON.stringify({ hapModuleInfos: [{ moduleName: "entry", mainElementName: "EntryAbility" }] }));',
    'else if (joined.includes("aa start")) answer("start ability successfully.");',
    'else if (joined.includes("dumpLayout")) answer("DumpLayout saved to:/data/local/tmp/layout.json");',
    'else if (args[2] === "file" && args[3] === "recv") {',
    '  const destination = args[5];',
    '  if (destination.endsWith(".json")) fs.writeFileSync(destination, LAYOUT);',
    '  else fs.writeFileSync(destination, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));',
    '  answer("FileTransfer finish");',
    '} else answer("No errors.");',
  ].join('\n');
}

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
  const runCliWith = (environment, expectedExit, ...args) => {
    const invoke = () =>
      execFileSync(
        process.execPath,
        ['node_modules/agent-device/bin/agent-device.mjs', ...args, '--json'],
        { cwd: scratch, env: environment, encoding: 'utf8', timeout: 120_000 },
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
  const runCli = (expectedExit, ...args) => runCliWith(cliEnv, expectedExit, ...args);
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

    // Now the same store with the family's toolchain present, named only by `HDC_SDK_PATH`: the
    // packed plugin must run a whole interaction on commands it resolved from that root. Nothing in
    // the bundle spawns through its own copy of the host kit, so the replies and the recorded calls
    // are the plugin's route through the host it was set up with.
    const toolchainRoot = path.join(scratch, 'toolchains');
    fs.mkdirSync(toolchainRoot, { recursive: true });
    const hdcCalls = path.join(scratch, 'hdc-calls.log');
    const stub = path.join(toolchainRoot, 'hdc');
    fs.writeFileSync(stub, hdcStubSource(hdcCalls), 'utf8');
    fs.chmodSync(stub, 0o755);
    // The stub stays off `PATH`, so a call reaching it can only have come from the documented root.
    const reachableFromPath = (cliEnv.PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .some((dir) => fs.existsSync(path.join(dir, 'hdc')));
    assert.ok(!reachableFromPath, 'the fixture HDC must not be reachable through PATH');
    // The running daemon was launched without the root, so the plugin needs a host that carries it.
    runCli(0, 'daemon', 'stop');
    const toolchainEnv = { ...cliEnv, HDC_SDK_PATH: toolchainRoot };

    const found = runCliWith(toolchainEnv, 0, 'devices', '--platform', 'harmonyos');
    assert.deepEqual(
      found.data.devices.map(({ id, name }) => ({ id, name })),
      [{ id: 'stub-target', name: 'StubPhone' }],
    );
    const opened = runCliWith(
      toolchainEnv,
      0,
      'open',
      'com.example.app',
      '--platform',
      'harmonyos',
    );
    assert.equal(opened.data.message, 'Opened: com.example.app');
    // The two capture commands, so the run covers a layout read and a screen grab as well as a
    // gesture: each answers from the stub's own fixture and is asserted on the reply it returned.
    const captured = runCliWith(toolchainEnv, 0, 'snapshot', '-i', '--platform', 'harmonyos');
    assert.deepEqual(
      captured.data.nodes.map(({ type, value }) => ({ type, value })),
      [{ type: 'Button', value: 'Continue' }],
    );
    const shot = path.join(scratch, 'screen.png');
    const shotResult = runCliWith(toolchainEnv, 0, 'screenshot', shot, '--platform', 'harmonyos');
    assert.equal(shotResult.data.path, shot);
    assert.deepEqual([...fs.readFileSync(shot).subarray(0, 3)], [0xff, 0xd8, 0xff]);
    const pressed = runCliWith(toolchainEnv, 0, 'press', '100', '200', '--platform', 'harmonyos');
    assert.equal(pressed.data.targetKind, 'point');
    runCliWith(toolchainEnv, 0, 'close', '--platform', 'harmonyos');

    const recorded = fs.readFileSync(hdcCalls, 'utf8').split('\n').filter(Boolean);
    const invoked = recorded.filter((line) => line.startsWith('ARGS: '));
    const paths = recorded.filter((line) => line.startsWith('PATH: '));
    assert.equal(paths.length, invoked.length, 'each recorded call names the PATH it ran with');
    assert.ok(
      invoked.some((line) => line.endsWith('list targets')),
      `discovery never ran the toolchain probe: ${invoked.join(' | ')}`,
    );
    assert.ok(
      invoked.some((line) => /^ARGS: -t stub-target shell uitest dumpLayout -p \S+$/.test(line)),
      `the snapshot never asked the device for a layout: ${invoked.join(' | ')}`,
    );
    assert.ok(
      invoked.some((line) =>
        /^ARGS: -t stub-target shell snapshot_display -f \S+\.jpeg$/.test(line),
      ),
      `the screenshot never asked the device for a frame: ${invoked.join(' | ')}`,
    );
    assert.ok(
      invoked.some((line) => line.endsWith('shell uitest uiInput click 100 200')),
      `the press command never reached HDC through the documented root: ${invoked.join(' | ')}`,
    );
    assert.ok(
      invoked.every((line) => line === 'ARGS: list targets' || line.includes('-t stub-target')),
      'every call after discovery names the discovered target',
    );
    // Each spawn got the root ahead of the host PATH, which is how the plugin reaches HDC without
    // the core naming HarmonyOS configuration.
    assert.ok(
      paths.every((line) => line.startsWith(`PATH: ${toolchainRoot}${path.delimiter}`)),
      `HDC ran with a PATH the plugin did not build: ${paths.join(' | ')}`,
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
