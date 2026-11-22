import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { installFakeManagedAgentBrowser } from '@agent-device/test-kit';

const repo = path.resolve(import.meta.dirname, '../../..');

/**
 * A stand-in for the managed web backend, written over the fixture install's own entry script. It
 * answers the envelopes this family's provider reads, appends every invocation to `logFile`, and
 * writes a PNG when asked for a screenshot, so a whole interaction runs without a real browser. The
 * log path is baked into the entry rather than passed by environment: the plugin builds each spawn
 * environment from the host it was set up with, so nothing this fixture needs travels through it.
 */
function managedBackendEntrySource(logFile) {
  return [
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    'const joined = args.join(" ");',
    'fs.appendFileSync(' +
      JSON.stringify(logFile) +
      String.raw`, "ARGS: " + joined + "\nHOME: " + process.env.HOME + "\nSOCKET: " + process.env.AGENT_BROWSER_SOCKET_DIR + "\n");`,
    // The provider puts the output path right after the verb, ahead of the envelope flags.
    'if (args[0] === "screenshot") {',
    '  const out = args[1];',
    '  fs.mkdirSync(require("node:path").dirname(out), { recursive: true });',
    '  fs.writeFileSync(out, Buffer.from([0x89, 0x50, 0x4e, 0x47]));',
    '}',
    String.raw`process.stdout.write(JSON.stringify({ success: true, data: {} }) + "\n");`,
  ].join('\n');
}

/**
 * A stand-in for npm on `PATH`. It answers only the managed-backend install — the plugin's own
 * `npm install --prefix <root> agent-browser@<version>` — by writing the package tree that install
 * leaves behind, and defers every other npm call to the real npm, so installing the packed plugin
 * through the CLI keeps working.
 */
function npmFixtureSource(realNpm) {
  return [
    '#!/bin/sh',
    'managed=0',
    'for a in "$@"; do',
    '  case "$a" in agent-browser@*) managed=1 ;; esac',
    'done',
    `if [ "$managed" != 1 ]; then exec ${JSON.stringify(realNpm)} "$@"; fi`,
    'prefix=""',
    'next=0',
    'for a in "$@"; do',
    '  if [ "$next" = 1 ]; then prefix="$a"; next=0; fi',
    '  if [ "$a" = "--prefix" ]; then next=1; fi',
    'done',
    'if [ -z "$prefix" ]; then exit 1; fi',
    'mkdir -p "$prefix/node_modules/agent-browser/dist" "$prefix/node_modules/.bin"',
    String.raw`printf 'process.exit(0)\n' > "$prefix/node_modules/agent-browser/dist/cli.js"`,
    String.raw`printf '#!/bin/sh\nexit 0\n' > "$prefix/node_modules/.bin/agent-browser"`,
    'chmod 755 "$prefix/node_modules/.bin/agent-browser"',
    'printf \'{"name":"agent-browser","version":"0.39.0","bin":{"agent-browser":"./dist/cli.js"}}\' > "$prefix/node_modules/agent-browser/package.json"',
    'exit 0',
  ].join('\n');
}

/**
 * The `--debug` records one CLI run printed to its own stderr: `--json` keeps stdout as the reply
 * alone. A run the CLI answers in process never reaches the daemon's request files, so this stream is
 * that request's whole trace.
 */
function debugRecordsOf(stderr) {
  return stderr
    .split('\n')
    .filter((line) => line.startsWith(DEBUG_RECORD_PREFIX))
    .map((line) => JSON.parse(line.slice(DEBUG_RECORD_PREFIX.length)));
}

const DEBUG_RECORD_PREFIX = '[agent-device][diag] ';

/**
 * Read the open record by its CLI-reported path. Use its directory to find follow-up records,
 * which the daemon names independently and the CLI does not report on success.
 */
function requestRecordsOf(openLogPath, phase, command) {
  const recordDir = path.dirname(openLogPath);
  const requestFiles =
    command === 'open'
      ? [openLogPath]
      : fs
          .readdirSync(recordDir)
          .filter((file) => file.endsWith('.ndjson'))
          .map((file) => path.join(recordDir, file));
  return requestFiles
    .flatMap((file) => fs.readFileSync(file, 'utf8').split('\n'))
    .filter((line) => line.includes(`"phase":"${phase}"`))
    .map((line) => JSON.parse(line))
    .filter((record) => record.command === command);
}

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
  // A `--debug` request writes its exec and timing records where the caller can read them back,
  // which is the route proof below: a plugin that spawned or timed through its own copy of the host
  // kit leaves the request without any.
  const debugCli = (...args) =>
    execFileSync(
      process.execPath,
      ['node_modules/agent-device/bin/agent-device.mjs', ...args, '--json', '--debug'],
      { cwd: scratch, env, encoding: 'utf8', timeout: 120_000 },
    );
  const storeRoot = env.AGENT_DEVICE_STATE_DIR;
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

    // The install lock, on the state dir a managed install has not yet touched. Claiming the lock
    // names this process's identity with a process-tool read, and the packed plugin carries no
    // process tool to make that read with (asserted below), so the host has to answer it — and the
    // `--debug` reply proves the host traced it into the request that asked for the install.
    // POSIX only: the npm stand-in below is a shell script.
    if (process.platform !== 'win32') {
      const bundleDir = path.join(
        env.AGENT_DEVICE_HOME,
        'plugins',
        runCli(0, 'plugins', 'list').data.plugins[0].installation,
        'node_modules',
        '@agent-device',
        'web',
        'dist',
      );
      const bundle = fs
        .readdirSync(bundleDir)
        .filter((file) => file.endsWith('.mjs'))
        .map((file) => [file, fs.readFileSync(path.join(bundleDir, file), 'utf8')]);
      assert.ok(bundle.length > 0, `no packed plugin chunks under ${bundleDir}`);
      assert.deepEqual(
        bundle.filter(([, source]) => source.includes('node:child_process')).map(([file]) => file),
        [],
        'the packed web plugin must carry no process tool of its own',
      );

      const binDir = path.join(scratch, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(
        path.join(binDir, 'npm'),
        npmFixtureSource(execFileSync('which', ['npm'], { env, encoding: 'utf8' }).trim()),
        { mode: 0o755 },
      );
      // `--debug` with no log file streams the request's records to stderr, `--json` keeping stdout
      // as the reply alone. A managed install is answered in the CLI's own process, so this stream is
      // that request's whole exec trace.
      const setup = spawnSync(
        process.execPath,
        ['node_modules/agent-device/bin/agent-device.mjs', 'web', 'setup', '--json', '--debug'],
        {
          cwd: scratch,
          env: { ...env, PATH: `${binDir}:${env.PATH}` },
          encoding: 'utf8',
          timeout: 300_000,
        },
      );
      const setupRecords = debugRecordsOf(String(setup.stderr ?? ''));
      assert.equal(setup.status, 0, `web setup failed: ${String(setup.stdout).slice(0, 400)}`);
      const setupSpawns = setupRecords
        .filter((record) => record.phase === 'exec_command' && record.data?.event === 'spawn')
        .map((record) => record.data.command);
      assert.ok(
        setupSpawns.includes('ps'),
        `the setup request traced no process-tool read out of ${setupRecords.length} records: ${JSON.stringify(
          setupSpawns,
        )}`,
      );
      assert.ok(
        setupSpawns.some((command) => command === 'npm' || command === 'node'),
        `the setup request traced no managed-backend install: ${JSON.stringify(setupSpawns)}`,
      );
    }

    const install = installFakeManagedAgentBrowser(storeRoot);
    assert.equal(runCli(0, 'web', 'doctor').data.status.installed, true);

    // Now the backend answers: the packed plugin must run a whole interaction on the managed entry,
    // with the managed environment it builds, on commands and timings the request can account for.
    const backendCalls = path.join(scratch, 'backend-calls.log');
    fs.writeFileSync(install.entryScript, managedBackendEntrySource(backendCalls), 'utf8');
    runCli(0, 'daemon', 'stop');

    // One named session for the whole interaction: the backend is told which session each call
    // belongs to, so the recorded argv names it too.
    const session = 'web-pack';
    const opened = JSON.parse(
      debugCli('open', 'https://example.test', '--platform', 'web', '--session', session),
    );
    const openLogPath = opened.data.requestLogPath;
    assert.equal(typeof openLogPath, 'string', 'open must report its diagnostics record path');
    debugCli('press', '100', '200', '--platform', 'web', '--session', session);
    const shot = path.join(scratch, 'screen.png');
    debugCli('screenshot', shot, '--platform', 'web', '--session', session);
    debugCli('snapshot', '--platform', 'web', '--session', session);
    debugCli('close', '--platform', 'web', '--session', session);

    const recorded = fs.readFileSync(backendCalls, 'utf8').split('\n').filter(Boolean);
    const invoked = recorded.filter((line) => line.startsWith('ARGS: '));
    const homes = recorded.filter((line) => line.startsWith('HOME: '));
    const sockets = recorded.filter((line) => line.startsWith('SOCKET: '));
    assert.equal(homes.length, invoked.length, 'each call names the home it ran with');
    // Each call carries the JSON envelope flag and the backend key of the caller's session, so a
    // call can only be attributed to this interaction's own browser session.
    const sent = (argv) =>
      invoked.some((line) => line.startsWith(`ARGS: ${argv} --json --session `));
    assert.ok(
      sent('open https://example.test'),
      `open never reached the backend: ${invoked.join(' | ')}`,
    );
    assert.ok(
      ['mouse move 100 200', 'mouse down', 'mouse up'].every((argv) => sent(argv)),
      `the press never sent its pointer sequence: ${invoked.join(' | ')}`,
    );
    assert.ok(
      sent(`screenshot ${shot}`),
      `the screenshot never asked for a frame: ${invoked.join(' | ')}`,
    );
    assert.ok(sent('close'), `close never reached the backend: ${invoked.join(' | ')}`);
    assert.ok(fs.existsSync(shot), 'the screenshot file the backend wrote is missing');
    // The managed environment the plugin builds — its own home and socket dir — reached the child.
    assert.ok(
      homes.every((line) => line === `HOME: ${install.runtimeHomeDir}`),
      `the backend ran with homes the plugin did not build: ${homes.join(' | ')}`,
    );
    assert.ok(
      sockets.every((line) => line === `SOCKET: ${install.socketDir}`),
      `the backend ran with socket dirs the plugin did not build: ${sockets.join(' | ')}`,
    );

    // The route proof. Each spawn is recorded in the exec trace of the request that asked for it,
    // and the snapshot's timing lands in that request's diagnostic store. Both live in the core's
    // copies of those stores, which a bundled host-kit copy never enters: spawned or timed through
    // it, these requests would carry no exec record and no capture timing at all.
    //
    // The fleet-record reads are the ones no backend reply can show. `open` starts a fleet, so the
    // provider derives its owned-process record from the host's process table, its per-pid identity
    // reads, and the executable path of each candidate — on macOS one `osascript`, on Windows one CIM
    // query. Read through a bundled host-kit copy instead, each read still succeeds — and the request
    // that owed it traces nothing, which is what the two assertions below refuse to accept.
    const openRecords = requestRecordsOf(openLogPath, 'exec_command', 'open');
    assert.ok(
      openRecords.some((record) => record.data?.event === 'spawn' && record.data.command === 'ps'),
      `the open request traced no process-table read out of ${openRecords.length} exec records: ${JSON.stringify(
        openRecords.map((record) => record.data),
      )}`,
    );
    if (process.platform === 'darwin') {
      assert.ok(
        openRecords.some(
          (record) => record.data?.event === 'spawn' && record.data.command === 'osascript',
        ),
        `the open request traced no executable-path read out of ${openRecords.length} exec records`,
      );
    }
    const nodeBasenames = new Set(['node', 'node.exe']);
    for (const [command, expected] of [
      ['open', 'open https://example.test'],
      ['press', 'mouse down'],
      ['screenshot', 'a screenshot call'],
      ['close', 'close'],
    ]) {
      const records = requestRecordsOf(openLogPath, 'exec_command', command);
      const spawns = records.filter((record) => record.data?.event === 'spawn');
      const exits = records.filter((record) => record.data?.event === 'exit');
      assert.ok(
        spawns.some((record) => nodeBasenames.has(record.data.command)),
        `the ${command} request traced no managed-backend spawn (${expected}) out of ${records.length} exec records`,
      );
      assert.ok(
        exits.every(
          (record) =>
            spawns.some((spawn) => spawn.data.execId === record.data.execId) &&
            record.data.exitCode === 0,
        ),
        `the ${command} request traced a backend call that did not exit cleanly: ${JSON.stringify(exits)}`,
      );
    }
    // The interactor's snapshot timer reports through the host too, so one capture timing is
    // attributed to the request that asked for the capture.
    assert.ok(
      requestRecordsOf(openLogPath, 'snapshot_capture', 'snapshot').some(
        (record) => record.data?.backend === 'web' && record.durationMs > 0,
      ),
      'the snapshot request carried no web capture timing',
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
