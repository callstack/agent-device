import assert from 'node:assert/strict';
import { runCmdSync } from '@agent-device/host-kit/command';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..');
function run(command, args, cwd) {
  return runCmdSync(command, args, {
    cwd,
    env: process.env,
    timeoutMs: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  }).stdout;
}
function runCli(cli, args, cwd, env, expectedExitCode = 0) {
  const result = runCmdSync(process.execPath, [cli, ...args], {
    cwd,
    env,
    timeoutMs: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    allowFailure: true,
  });
  assert.equal(result.exitCode, expectedExitCode, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

/**
 * Stops the detached daemon the packed CLI started for this state dir and proves from the
 * daemon's own status that none survives. `--clean` is allowed only on proven detached ownership,
 * so a live record refusing that stop would mean the CLI held something this test does not own.
 */
function assertIsolatedDaemonStopped(cli, cwd, env, stateDir) {
  const stop = runCli(
    cli,
    ['daemon', 'stop', '--clean', '--state-dir', stateDir, '--json'],
    cwd,
    env,
  );
  const status = runCli(cli, ['daemon', 'status', '--state-dir', stateDir, '--json'], cwd, env);
  assert.equal(status.data.state, 'stopped', JSON.stringify({ stop, status }));
}

test('packed core CLI and SDK run an installed replay plugin through the detached daemon', async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-package-'));
  try {
    const coreTarball = path.join(
      scratch,
      JSON.parse(
        run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], root),
      )[0].filename,
    );
    const pluginTarball = path.join(scratch, 'replay.tgz');
    run('pnpm', ['pack', '--out', pluginTarball], path.join(root, 'packages/replay'));
    const consumer = path.join(scratch, 'consumer');
    fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, 'package.json'), '{"private":true,"type":"module"}');
    run(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', coreTarball, pluginTarball],
      consumer,
    );
    const core = path.join(consumer, 'node_modules/agent-device');
    const plugin = path.join(consumer, 'node_modules/@agent-device/replay');
    const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.exports), ['./agent-device']);
    assert.equal(manifest.dependencies, undefined);
    assert.equal(manifest.peerDependencies, undefined);
    assert.ok(!fs.existsSync(path.join(plugin, 'node_modules/agent-device')));
    const coreCode = files(path.join(core, 'dist'))
      .filter((file) => file.endsWith('.js'))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    for (const engineMarker of [
      'Expected passing replay test outcome.',
      'replay accepts .ad script files. JSON replay payloads are no longer supported.',
    ])
      assert.ok(
        !coreCode.includes(engineMarker),
        `Executable native engine leaked: ${engineMarker}`,
      );
    const pluginCode = files(path.join(plugin, 'dist'))
      .filter((file) => file.endsWith('.mjs'))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    assert.ok(pluginCode.includes('Expected passing replay test outcome.'));
    assert.ok(pluginCode.includes('JSON replay payloads are no longer supported.'));
    for (const command of ['replay', 'test']) {
      const help = run(
        process.execPath,
        [path.join(core, 'bin/agent-device.mjs'), 'help', command],
        consumer,
      );
      assert.match(help, /plugin, install separately/);
      assert.match(help, /agent-device plugins add @agent-device\/replay/);
    }
    await t.test('packed replay plugin with the private source host', () => {
      assert.match(
        run(
          process.execPath,
          [
            '--experimental-strip-types',
            path.join(root, 'packages/replay/test/packed-runtime.mjs'),
            core,
            plugin,
            scratch,
          ],
          consumer,
        ),
        /Packed native replay plugin passed against the source host/,
      );
    });

    // The managed route: the same packed core CLI selects the archive through its own public
    // `plugins add`, with no embedded factory and no workspace to borrow an engine from.
    const cli = path.join(core, 'bin/agent-device.mjs');
    const managedHome = path.join(scratch, 'managed-home');
    const managedStateDir = path.join(scratch, 'managed-state');
    const unclaimedHome = path.join(scratch, 'unclaimed-home');
    const managedEnv = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith('AGENT_DEVICE_')),
      ),
      AGENT_DEVICE_HOME: managedHome,
      AGENT_DEVICE_STATE_DIR: managedStateDir,
      AGENT_DEVICE_CLAIMS_DIR: path.join(scratch, 'managed-claims'),
      HOME: unclaimedHome,
    };
    const script = path.join(consumer, 'noop.ad');
    fs.writeFileSync(script, '# managed CLI replay entrypoint and suite transport\n');
    let primaryError;
    try {
      // Before the selection exists, the CLI's own daemon has no ad engine to borrow.
      const unselected = runCli(
        cli,
        ['replay', script, '--session', 'package-managed-unselected', '--json'],
        consumer,
        managedEnv,
        1,
      );
      assert.equal(unselected.success, false);
      assert.equal(unselected.error.code, 'INVALID_ARGS');
      const details = unselected.error.details;
      assert.equal(details.reason, 'plugin-not-installed');
      assert.equal(details.backend, 'ad');
      assert.equal(details.package, '@agent-device/replay');
      const coreVersion = JSON.parse(
        fs.readFileSync(path.join(core, 'package.json'), 'utf8'),
      ).version;
      const sourceBuild = coreVersion.endsWith('-dev');
      assert.equal(
        details.installCommand,
        sourceBuild
          ? 'agent-device plugins add @agent-device/replay@nightly-0.22'
          : 'agent-device plugins add @agent-device/replay',
      );
      assert.equal(details.requiredVersion, sourceBuild ? undefined : coreVersion);
      assertIsolatedDaemonStopped(cli, consumer, managedEnv, managedStateDir);

      const added = runCli(cli, ['plugins', 'add', pluginTarball, '--json'], consumer, managedEnv);
      const expectedIntegrity = `sha512-${crypto
        .createHash('sha512')
        .update(fs.readFileSync(pluginTarball))
        .digest('base64')}`;
      assert.equal(added.data.artifact.name, '@agent-device/replay');
      assert.equal(added.data.artifact.integrity, expectedIntegrity);
      assert.equal(added.data.artifact.compatibility, 'unchecked');
      assert.equal(added.data.restartRequired, true);
      assert.equal(fs.existsSync(path.join(unclaimedHome, '.agent-device', 'config.json')), false);
      assert.equal(fs.existsSync(path.join(unclaimedHome, '.agent-device', 'plugins')), false);
      const inventory = runCli(cli, ['plugins', 'list', '--json'], consumer, managedEnv);
      const selected = inventory.data.plugins.find(
        (entry) => entry.name === '@agent-device/replay',
      );
      assert.equal(typeof added.data.artifact.installation, 'string');
      assert.equal(selected?.installation, added.data.artifact.installation);
      assert.equal(selected?.integrity, expectedIntegrity);
      assert.equal(selected?.backend, 'ad');
      assert.equal(selected?.compatible, true);

      const replay = runCli(
        cli,
        ['replay', script, '--session', 'package-managed-replay', '--json'],
        consumer,
        managedEnv,
      );
      assert.equal(replay.success, true);
      assert.equal(replay.data.replayed, 0);
      assert.equal(replay.data.sessionActive, false);
      assert.deepEqual(replay.data.artifactPaths, []);

      const suite = runCli(
        cli,
        [
          'test',
          script,
          '--session',
          'package-managed-suite',
          '--artifacts-dir',
          path.join(scratch, 'managed-artifacts'),
          '--json',
        ],
        consumer,
        managedEnv,
      );
      assert.equal(suite.success, true);
      assert.equal(suite.data.executed, 1);
      assert.equal(suite.data.passed, 1);
      assert.equal(suite.data.failed, 0);
      assert.deepEqual(suite.data.failures, []);
      const [suiteTest] = suite.data.tests;
      assert.equal(suiteTest.status, 'passed');
      assert.equal(suiteTest.replayed, 0);
      assert.ok(fs.existsSync(suiteTest.artifactsDir));

      // The daemon that served both commands came from the store selection in this scratch home.
      const running = runCli(
        cli,
        ['daemon', 'status', '--state-dir', managedStateDir, '--json'],
        consumer,
        managedEnv,
      );
      assert.equal(running.data.state, 'running');
      assert.equal(running.data.ownership, 'detached');
      const served = running.data.plugins.find((entry) => entry.package === '@agent-device/replay');
      assert.equal(served?.source, 'store');
      assert.equal(served?.state, 'active');
      const sdkReplay = JSON.parse(
        runCmdSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import { createAgentDeviceClient } from 'agent-device';
             const client = createAgentDeviceClient({ session: 'package-managed-sdk' });
             console.log(JSON.stringify(await client.replay.run({ path: process.argv[1] })));`,
            script,
          ],
          { cwd: consumer, env: managedEnv, timeoutMs: 120_000 },
        ).stdout,
      );
      assert.equal(sdkReplay.replayed, 0);
      assert.equal(sdkReplay.sessionActive, false);
      assert.deepEqual(sdkReplay.artifactPaths, []);
    } catch (error) {
      primaryError = error;
    }
    try {
      assertIsolatedDaemonStopped(cli, consumer, managedEnv, managedStateDir);
    } catch (cleanupError) {
      if (primaryError !== undefined) {
        throw new AggregateError(
          [primaryError, cleanupError],
          'Replay smoke and daemon cleanup failed',
        );
      }
      throw cleanupError;
    }
    if (primaryError !== undefined) throw primaryError;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
