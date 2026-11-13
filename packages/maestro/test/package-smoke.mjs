import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..');
function run(command, args, cwd, env = process.env) {
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

test('packed core excludes the engine and the managed plugin works without workspace dependencies', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-maestro-package-'));
  try {
    const coreTarball = path.join(
      scratch,
      JSON.parse(
        run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], root),
      )[0].filename,
    );
    const pluginTarball = path.join(scratch, 'maestro.tgz');
    run('pnpm', ['pack', '--out', pluginTarball], path.join(root, 'packages/maestro'));
    const consumer = path.join(scratch, 'consumer');
    const home = path.join(scratch, 'home');
    const installation = crypto.randomUUID();
    const store = path.join(home, 'plugins', installation);
    for (const directory of [consumer, store]) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'package.json'), '{"private":true,"type":"module"}');
    }
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', coreTarball], consumer);
    const core = path.join(consumer, 'node_modules/agent-device');
    const cli = path.join(core, 'bin/agent-device.mjs');
    const env = {
      ...process.env,
      AGENT_DEVICE_HOME: home,
      AGENT_DEVICE_STATE_DIR: path.join(scratch, 'state'),
      AGENT_DEVICE_NO_UPDATE: '1',
    };
    const coreCode = files(path.join(core, 'dist'))
      .filter((file) => file.endsWith('.js'))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    assert.ok(!coreCode.includes('Maestro runScript process exited without a result'));
    assert.ok(
      !files(path.join(core, 'dist')).some((file) => /run-script-(?:http-)?child\./.test(file)),
    );
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
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', pluginTarball], store);
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ plugins: { '@agent-device/maestro': { installation } } }),
    );
    const plugin = path.join(store, 'node_modules/@agent-device/maestro');
    const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.exports), ['./agent-device']);
    assert.equal(manifest.dependencies, undefined);
    assert.equal(manifest.peerDependencies, undefined);
    assert.ok(!fs.existsSync(path.join(store, 'node_modules/agent-device')));
    for (const entry of [
      'agent-device.mjs',
      'agent-device.d.mts',
      'png-worker.mjs',
      'run-script-child.mjs',
      'run-script-http-child.mjs',
    ])
      assert.ok(fs.existsSync(path.join(plugin, 'dist', entry)), entry);
    const exported = JSON.parse(
      run(process.execPath, [cli, 'replay', 'export', script, '--json'], consumer, env),
    );
    assert.equal(exported.success, true);
    assert.match(exported.data.yaml, /com.example.app/);
    const childScript = path.join(scratch, 'output.js');
    fs.writeFileSync(childScript, 'output.result = VALUE;');
    const child = execFileSync(process.execPath, [path.join(plugin, 'dist/run-script-child.mjs')], {
      input: JSON.stringify({
        scriptPath: childScript,
        env: { VALUE: 'packed-helper' },
        publicNetworkOnly: false,
      }),
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(child), { outputEnv: { 'output.result': 'packed-helper' } });
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
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
