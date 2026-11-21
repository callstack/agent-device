import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');

/**
 * A stand-in for the Vega SDK CLI, written into a directory that is on the host `PATH` the CLI and
 * the daemon are launched with and nowhere else. It answers the calls this family asks a Vega
 * Virtual Device, and appends every invocation to `logFile` so the test can prove which argv and
 * which environment reached the tool. The log path is baked into the stub rather than passed by
 * environment: the plugin spawns with the host environment it was set up with, so nothing this
 * fixture needs travels through it.
 */
function vegaStubSource(logFile) {
  return [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    'const joined = args.join(" ");',
    'fs.appendFileSync(' +
      JSON.stringify(logFile) +
      String.raw`, "ARGS: " + joined + "\nPATH: " + process.env.PATH + "\nHOME: " + process.env.HOME + "\n");`,
    String.raw`const answer = (text) => process.stdout.write(text + "\n");`,
    'if (joined === "--version") answer("0.2.0");',
    'else if (joined.includes("device list")) answer("VirtualDevice : running");',
    'else if (joined.includes("is-connected")) answer("VirtualDevice is connected");',
    'else if (joined.includes("launch-app")) answer("Launched");',
    'else if (joined.includes("terminate-app")) answer("Terminated");',
    'else answer("ok");',
  ].join('\n');
}

/**
 * The exec records a `--debug` request wrote, from the request records the daemon keeps under its
 * session dirs. Records are matched by the CLI command they belong to, so an empty answer means the
 * request traced no spawn at all rather than that its file was not found.
 */
function execRecordsOf(storeRoot, command) {
  const sessionsDir = path.join(storeRoot, 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];
  const requestFiles = fs
    .readdirSync(sessionsDir)
    .flatMap((session) => {
      const requestsDir = path.join(sessionsDir, session, 'requests');
      return fs.existsSync(requestsDir)
        ? fs.readdirSync(requestsDir).map((request) => path.join(requestsDir, request))
        : [];
    })
    .filter((file) => file.endsWith('.ndjson'));
  return requestFiles
    .flatMap((file) => fs.readFileSync(file, 'utf8').split('\n'))
    .filter((line) => line.includes('"phase":"exec_command"'))
    .map((line) => JSON.parse(line))
    .filter((record) => record.command === command);
}

test('packed core discovers vega only after the managed platform is installed', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-vega-pack-'));
  // The Vega CLI is a host tool the plugin reads through PATH and through the home's default
  // install. A machine that has it installed would answer its own device list, so every CLI run
  // names a host that carries neither: the installed plugin then always answers its toolchain
  // report, on any machine.
  const stubBin = path.join(scratch, 'stub-bin');
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('AGENT_DEVICE_')),
    ),
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
  const exec = (command, args, cwd = scratch, environment = env) =>
    execFileSync(command, args, { cwd, env: environment, encoding: 'utf8', timeout: 120_000 });
  const cli = (...args) =>
    exec(process.execPath, ['node_modules/agent-device/bin/agent-device.mjs', ...args]);
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
  // The daemon environment is captured when the CLI starts it, so the stub directory has to be on
  // the PATH of the process that launches it.
  const stubEnv = () => ({ ...cliEnv, PATH: [stubBin, cliEnv.PATH].join(path.delimiter) });
  // A `--debug` request writes its own exec records to the daemon log: the route proof below reads
  // them back, which is what a spawn through the bundle's own host-kit copy cannot produce.
  const debugCli = (...args) =>
    execFileSync(
      process.execPath,
      ['node_modules/agent-device/bin/agent-device.mjs', ...args, '--json', '--debug'],
      { cwd: scratch, env: stubEnv(), encoding: 'utf8', timeout: 120_000 },
    );
  const storeRoot = env.AGENT_DEVICE_STATE_DIR;
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

    // Now the same store with the Vega CLI present on the host `PATH`: the packed plugin must run a
    // whole interaction on calls it resolved and spawned through the host it was set up with. A
    // bundle that spawned through its own copy of the host kit would answer these replies too — and
    // leave the request's log without one exec record, which is what the trace check below refuses.
    fs.mkdirSync(stubBin, { recursive: true });
    const vegaCalls = path.join(scratch, 'vega-calls.log');
    const stub = path.join(stubBin, process.platform === 'win32' ? 'vega.cmd' : 'vega');
    fs.writeFileSync(stub, vegaStubSource(vegaCalls), 'utf8');
    fs.chmodSync(stub, 0o755);
    // The running daemon was launched without the stub directory, so the CLI that starts its daemon
    // must carry it, and the stub has to be off the plain host PATH before this point.
    assert.ok(
      !(cliEnv.PATH ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .some((dir) => fs.existsSync(path.join(dir, 'vega'))),
      'the fixture Vega CLI must not be reachable before the scenario adds it',
    );
    runCli(0, 'daemon', 'stop');
    const found = runCliWith(stubEnv(), 0, 'devices', '--platform', 'vega');
    assert.deepEqual(
      found.data.devices.map(({ id, platform }) => ({ id, platform })),
      [{ id: 'VirtualDevice', platform: 'vega' }],
    );
    debugCli('open', 'com.example.app.main', '--platform', 'vega', '--target', 'tv');
    debugCli(
      'tv-remote',
      'press',
      'down',
      '--platform',
      'vega',
      '--target',
      'tv',
      '--duration-ms',
      '120',
    );
    debugCli('close', 'com.example.app.main', '--platform', 'vega');

    const recorded = fs.readFileSync(vegaCalls, 'utf8').split('\n').filter(Boolean);
    const invoked = recorded.filter((line) => line.startsWith('ARGS: '));
    const homes = recorded.filter((line) => line.startsWith('HOME: '));
    assert.equal(homes.length, invoked.length, 'each recorded call names the home it ran with');
    assert.ok(
      invoked.some((line) => line === 'ARGS: device list'),
      `discovery never asked the CLI for devices: ${invoked.join(' | ')}`,
    );
    assert.ok(
      invoked.some((line) =>
        /^ARGS: device launch-app --device VirtualDevice --appName com\.example\.app\.main$/.test(
          line,
        ),
      ),
      `open never launched an app through the CLI: ${invoked.join(' | ')}`,
    );
    assert.ok(
      invoked.some(
        (line) =>
          line ===
          'ARGS: device run-cmd --device VirtualDevice --command inputd-cli button_press KEY_DOWN --holdDuration 120',
      ),
      `the remote press never reached the CLI: ${invoked.join(' | ')}`,
    );
    assert.ok(
      invoked.some((line) =>
        /^ARGS: device terminate-app --device VirtualDevice --appName /.test(line),
      ),
      `close never terminated the app: ${invoked.join(' | ')}`,
    );
    // Each spawn got the host home the plugin was set up with, not the daemon user's home.
    assert.ok(
      homes.every((line) => line === `HOME: ${scratch}`),
      `the CLI ran with homes the plugin did not build: ${homes.join(' | ')}`,
    );

    // The route proof: every CLI call of a `--debug` request is recorded in that request's exec
    // trace. Spawned through the bundle's own host-kit copy instead, the trace is empty — the calls
    // would be unattributable to the request that asked for them.
    // Each call names itself by its timeout: discovery asks 10s, an app command 30s, and the remote
    // press above 10s plus its hold duration. Discovery runs on the core's own route on any build,
    // so a bare "the request traced a `vega` spawn" would pass while the interactor's own call went
    // untraced; naming the timeout is what pins the call the plugin itself made.
    for (const [command, timeoutMs, expected] of [
      ['open', 30_000, 'device launch-app'],
      ['tv-remote', 10_120, 'button_press'],
      ['close', 30_000, 'device terminate-app'],
    ]) {
      const records = execRecordsOf(storeRoot, command);
      const spawns = records.filter(
        (record) => record.data?.event === 'spawn' && record.data.timeoutMs === timeoutMs,
      );
      const exits = records.filter(
        (record) => record.data?.event === 'exit' && record.data.timeoutMs === timeoutMs,
      );
      assert.equal(
        spawns.length,
        1,
        `the ${command} request traced ${spawns.length} '${expected}' spawns out of ${records.length} exec records`,
      );
      assert.equal(
        exits.length,
        1,
        `the ${command} request never saw its '${expected}' call exit: ${JSON.stringify(exits)}`,
      );
      assert.equal(spawns[0].data.command, 'vega');
      assert.equal(exits[0].data.execId, spawns[0].data.execId);
      assert.equal(exits[0].data.exitCode, 0);
    }
  } finally {
    try {
      if (fs.existsSync(path.join(scratch, 'node_modules/agent-device')))
        runCli(0, 'daemon', 'stop');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
});
