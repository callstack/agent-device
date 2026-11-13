import http from 'node:http';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
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

test('packed core excludes the engine and the managed plugin works without workspace dependencies', async (t) => {
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
    await assertPackagedRunScriptChildren(plugin, scratch);
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
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

async function assertPackagedRunScriptChildren(plugin, scratch) {
  const alias = path.join(scratch, 'plugin-alias');
  fs.symlinkSync(plugin, alias, 'dir');
  const server = http.createServer((_request, response) =>
    response.end('x'.repeat(2 * 1024 * 1024)),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const scriptPath = path.join(scratch, 'http.js');
    fs.writeFileSync(scriptPath, 'output.size = http.post(SERVER_URL).body.length');
    for (const directory of [plugin, alias]) {
      const result = promisify(execFile)(
        process.execPath,
        [path.join(directory, 'dist/run-script-child.mjs')],
        { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      );
      result.child.stdin.end(
        JSON.stringify({
          scriptPath,
          env: { SERVER_URL: `http://127.0.0.1:${server.address().port}/` },
          publicNetworkOnly: false,
        }),
      );
      assert.deepEqual(JSON.parse((await result).stdout), {
        outputEnv: { 'output.size': String(2 * 1024 * 1024) },
      });
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
