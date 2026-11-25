import { run } from './package-test-support.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..');
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

test('packed core excludes the engine and the managed plugin works without workspace dependencies', async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-maestro-package-'));
  let cleanup;
  try {
    const coreTarball = path.join(
      scratch,
      JSON.parse(
        run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], root),
      )[0].filename,
    );
    const pluginTarball = path.join(scratch, 'maestro.tgz');
    run('pnpm', ['pack', '--out', pluginTarball], path.join(root, 'packages/maestro'));
    const integrity = `sha512-${crypto
      .createHash('sha512')
      .update(fs.readFileSync(pluginTarball))
      .digest('base64')}`;
    const consumer = path.join(scratch, 'consumer');
    const home = path.join(scratch, 'home');
    fs.mkdirSync(consumer, { recursive: true });
    fs.writeFileSync(path.join(consumer, 'package.json'), '{"private":true,"type":"module"}');
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', coreTarball], consumer);
    const core = path.join(consumer, 'node_modules/agent-device');
    const cli = path.join(core, 'bin/agent-device.mjs');
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith('AGENT_DEVICE_')),
      ),
      HOME: path.join(scratch, 'user-home'),
      AGENT_DEVICE_CLAIMS_DIR: path.join(scratch, 'claims'),
      AGENT_DEVICE_HOME: home,
      AGENT_DEVICE_STATE_DIR: path.join(scratch, 'state'),
      AGENT_DEVICE_NO_UPDATE: '1',
    };
    cleanup = () => {
      run(
        process.execPath,
        [cli, 'daemon', 'stop', '--clean', '--state-dir', env.AGENT_DEVICE_STATE_DIR, '--json'],
        consumer,
        env,
      );
      const status = JSON.parse(
        run(
          process.execPath,
          [cli, 'daemon', 'status', '--state-dir', env.AGENT_DEVICE_STATE_DIR, '--json'],
          consumer,
          env,
        ),
      );
      assert.equal(status.data.state, 'stopped');
    };
    const coreCode = files(path.join(core, 'dist'))
      .filter((file) => file.endsWith('.js'))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    assert.ok(!coreCode.includes('Maestro runScript process exited without a result'));
    assert.ok(
      !files(path.join(core, 'dist')).some((file) => /run-script-(?:http-)?child\./.test(file)),
    );
    const flow = path.join(scratch, 'no-device.yaml');
    fs.writeFileSync(flow, 'appId: com.example.app\n---\n- evalScript: ${output.value = "ok"}\n');
    const replayArgs = [
      'replay',
      flow,
      '--maestro',
      '--platform',
      'ios',
      '--session',
      'packed-maestro',
      '--json',
    ];
    const script = path.join(scratch, 'flow.ad');
    fs.writeFileSync(script, 'open com.example.app\n');
    assert.match(
      run(process.execPath, [cli, 'help', 'maestro'], consumer, env),
      /plugins add @agent-device\/maestro/,
    );
    const missing = run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { spawnSync } from 'node:child_process';
      const result = spawnSync(process.execPath, ${JSON.stringify([cli, 'replay', 'export', script, '--json'])}, { encoding: 'utf8' });
      if (result.status === 0) throw new Error('missing plugin succeeded');
      process.stdout.write(result.stdout + result.stderr);
    `,
      ],
      consumer,
      env,
    );
    assert.match(missing, /plugin-not-installed/);
    assert.match(missing, /agent-device plugins add @agent-device\/maestro/);
    const absentReplay = run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { spawnSync } from 'node:child_process';
      const result = spawnSync(process.execPath, ${JSON.stringify([cli, ...replayArgs])}, { encoding: 'utf8' });
      if (result.status !== 1) throw new Error('missing Maestro replay did not fail');
      process.stdout.write(result.stdout);
    `,
      ],
      consumer,
      env,
    );
    const absent = JSON.parse(absentReplay);
    assert.equal(absent.success, false);
    assert.equal(absent.error.details.reason, 'plugin-not-installed');
    assert.equal(absent.error.details.package, '@agent-device/maestro');
    cleanup();
    const added = JSON.parse(
      run(process.execPath, [cli, 'plugins', 'add', pluginTarball, '--json'], consumer, env),
    );
    assert.equal(added.success, true);
    const { artifact } = added.data;
    assert.equal(artifact.name, '@agent-device/maestro');
    assert.equal(artifact.integrity, integrity);
    assert.equal(artifact.compatibility, 'unchecked');
    assert.match(artifact.installation, /^[a-f0-9-]{36}$/);
    assert.equal(added.data.restartRequired, true);
    const listed = JSON.parse(
      run(process.execPath, [cli, 'plugins', 'list', '--json'], consumer, env),
    );
    assert.equal(listed.success, true);
    assert.deepEqual(listed.data.plugins, [
      {
        name: '@agent-device/maestro',
        installation: artifact.installation,
        integrity: artifact.integrity,
        version: artifact.version,
        backend: 'maestro',
        compatible: true,
      },
    ]);
    const replay = JSON.parse(run(process.execPath, [cli, ...replayArgs], consumer, env));
    assert.equal(replay.success, true);
    assert.equal(replay.data.replayed, 1);
    const status = JSON.parse(
      run(
        process.execPath,
        [cli, 'daemon', 'status', '--state-dir', env.AGENT_DEVICE_STATE_DIR, '--json'],
        consumer,
        env,
      ),
    );
    assert.equal(status.data.state, 'running');
    assert.ok(
      status.data.plugins.some(
        (entry) =>
          entry.package === '@agent-device/maestro' &&
          entry.source === 'store' &&
          entry.state === 'active',
      ),
    );
    const store = path.join(home, 'plugins', artifact.installation);
    const plugin = path.join(store, 'node_modules/@agent-device/maestro');
    const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'), 'utf8'));
    assert.equal(manifest.version, artifact.version);
    const exported = JSON.parse(
      run(process.execPath, [cli, 'replay', 'export', script, '--json'], consumer, env),
    );
    assert.equal(exported.success, true);
    assert.match(exported.data.yaml, /com.example.app/);
    for (const mode of [
      'diagnostics',
      'worker-ownership',
      'embedded-worker',
      'run-script-debug',
      'run-script-env',
    ]) {
      await t.test(`packed runtime ${mode}`, () => {
        const output = run(
          process.execPath,
          [
            '--experimental-strip-types',
            path.join(root, 'packages/maestro/test/packed-runtime.mjs'),
            plugin,
            scratch,
            mode,
            core,
          ],
          consumer,
          env,
        );
        process.stdout.write(output);
      });
    }
    const entry = manifest.exports['./agent-device'].import;
    const broken = path.join(plugin, entry);
    fs.renameSync(broken, `${broken}.missing`);
    const failed = run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { spawnSync } from 'node:child_process';
      const result = spawnSync(process.execPath, ${JSON.stringify([cli, 'replay', 'export', script, '--json'])}, { encoding: 'utf8' });
      if (result.status === 0) throw new Error('broken plugin succeeded');
      process.stdout.write(result.stdout + result.stderr);
    `,
      ],
      consumer,
      env,
    );
    assert.match(failed, /plugin_load_failed/);
    assert.ok(!failed.includes('plugin-not-installed'));
  } finally {
    try {
      cleanup?.();
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
});
