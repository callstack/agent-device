// Manual pre-push check for provider plugin packages; no CI lane runs it (it needs pnpm and a
// built core). Usage: `pnpm build && node scripts/check-provider-plugin.mjs packages/provider-testmu`.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const plugin = path.resolve(root, process.argv[2]);
const fixture = await import(pathToFileURL(path.join(plugin, 'test/package-smoke.mjs')).href);
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-plugin-package-'));
const consumer = path.join(scratch, 'consumer');
const home = path.join(scratch, 'home');
const installation = crypto.randomUUID();
const project = path.join(home, 'plugins', installation);
let rejectCredentials = true;
const requests = [];
const server = http.createServer((request, response) => {
  requests.push(request.url);
  const result = fixture.respond(request.url, rejectCredentials);
  response.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(result.body));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
async function run(command, args, cwd) {
  return await exec(command, args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
}
async function pack(directory) {
  if (directory === plugin) {
    const tarball = path.join(scratch, 'plugin.tgz');
    await run('pnpm', ['pack', '--out', tarball], directory);
    return tarball;
  }
  const { stdout } = await run(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch],
    directory,
  );
  return path.join(scratch, JSON.parse(stdout)[0].filename);
}
try {
  await run('pnpm', ['build'], plugin);
  const coreTarball = await pack(root);
  const pluginTarball = await pack(plugin);
  for (const directory of [consumer, project]) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'package.json'), '{"private":true,"type":"module"}');
  }
  await run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', coreTarball],
    consumer,
  );
  await run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', pluginTarball],
    project,
  );
  const manifest = JSON.parse(await fs.readFile(path.join(plugin, 'package.json'), 'utf8'));
  const installed = JSON.parse(
    await fs.readFile(path.join(project, 'node_modules', manifest.name, 'package.json'), 'utf8'),
  );
  assert.deepEqual(installed.exports, { '.': { import: './dist/plugin.mjs' } });
  assert.equal(installed.dependencies, undefined);
  assert.equal(installed.peerDependencies, undefined);
  await assert.rejects(fs.stat(path.join(project, 'node_modules', 'agent-device')), {
    code: 'ENOENT',
  });
  await fs.writeFile(
    path.join(home, 'config.json'),
    JSON.stringify({ plugins: { [manifest.name]: { installation } } }),
  );
  const core = path.join(consumer, 'node_modules', 'agent-device');
  const coreManifest = JSON.parse(await fs.readFile(path.join(core, 'package.json'), 'utf8'));
  const bin = path.resolve(core, coreManifest.bin['agent-device']);
  const env = {
    ...process.env,
    ...fixture.environment(endpoint),
    AGENT_DEVICE_HOME: home,
    AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1',
  };
  const preload = path.join(scratch, 'fetch-fixture.mjs');
  await fs.writeFile(
    preload,
    `const originalFetch = globalThis.fetch;
const redirects = ${JSON.stringify(fixture.fetchRedirects ?? [])};
globalThis.fetch = (input, init) => {
  let url = String(input);
  for (const prefix of redirects) if (url.startsWith(prefix)) url = ${JSON.stringify(endpoint)} + url.slice(prefix.length);
  if (new URL(url).hostname !== '127.0.0.1') throw new Error('Unexpected external request: ' + url);
  return originalFetch(url, init);
};`,
  );
  const command = async (args) => {
    try {
      return await exec(process.execPath, ['--import', preload, bin, ...args, '--json'], {
        cwd: consumer,
        env,
        timeout: 30_000,
      });
    } catch (error) {
      if (typeof error.stdout !== 'string') throw error;
      return error;
    }
  };
  const listed = await command(['plugins', 'list']);
  assert.equal(listed.code, undefined, listed.stderr);
  const rejected = await command([
    'connect',
    manifest.agentDevicePlugin.provider,
    ...fixture.args,
    '--state-dir',
    path.join(scratch, 'state'),
  ]);
  assert.equal(
    JSON.parse(rejected.stdout).error.code,
    'UNAUTHORIZED',
    rejected.stdout + rejected.stderr,
  );
  rejectCredentials = false;
  const connected = await command([
    'connect',
    manifest.agentDevicePlugin.provider,
    ...fixture.args,
    '--state-dir',
    path.join(scratch, 'state'),
  ]);
  assert.equal(connected.code, undefined, connected.stdout + connected.stderr);
  assert.ok(requests.length > 0);
  console.log(
    `Packed ${manifest.name}: isolated install, host-recognized errors, and CLI connect passed.`,
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(scratch, { recursive: true, force: true });
}
