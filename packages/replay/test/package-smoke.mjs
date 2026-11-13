import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..');
function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    env: process.env,
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

test('packed core excludes native execution and a standalone replay plugin uses the real host', () => {
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
    assert.match(
      run(
        process.execPath,
        [path.join(root, 'packages/replay/test/packed-runtime.mjs'), core, plugin, scratch],
        consumer,
      ),
      /Packed native replay/,
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
