import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { run, assertPackagedRunScriptChildren } from './package-test-support.mjs';

const root = path.resolve(import.meta.dirname, '../../..');

test('packed managed plugin contains its factory and runs real script children without workspace dependencies', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-maestro-artifact-'));
  try {
    const pluginTarball = path.join(scratch, 'maestro.tgz');
    run('pnpm', ['pack', '--out', pluginTarball], path.join(root, 'packages/maestro'));
    const store = path.join(scratch, 'store');
    fs.mkdirSync(store);
    fs.writeFileSync(path.join(store, 'package.json'), '{"private":true,"type":"module"}');
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', pluginTarball], store);
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
      'THIRD_PARTY_NOTICES.txt',
    ])
      assert.ok(fs.existsSync(path.join(plugin, 'dist', entry)), entry);
    await assertPackagedRunScriptChildren(plugin, scratch);
    run(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(import.meta.dirname, 'packed-clickability.mjs'),
        plugin,
        scratch,
      ],
      root,
    );
    run(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(import.meta.dirname, 'packed-screen-origin.mjs'),
        plugin,
        scratch,
      ],
      root,
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
