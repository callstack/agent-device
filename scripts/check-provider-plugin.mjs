// Manual pre-push check for provider plugin packages; no CI lane runs it (it needs pnpm and a
// built core). Usage: `pnpm build && pnpm check:provider-plugin packages/provider-testmu`.
// A fixture without `respond` is for a provider with no credentials: connect must pass at once.
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
  const result = fixture.respond
    ? fixture.respond(request.url, rejectCredentials)
    : { status: 500, body: { error: 'this fixture answers no requests' } };
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
  // AGENT_DEVICE_CORE_SPEC installs a published agent-device (such as agent-device@0.21.28) instead
  // of packing this checkout, to prove a plugin still loads on a host without the newest contract.
  const coreSpec = process.env.AGENT_DEVICE_CORE_SPEC ?? (await pack(root));
  const pluginTarball = await pack(plugin);
  const sha256 = async (file) =>
    crypto
      .createHash('sha256')
      .update(await fs.readFile(file))
      .digest('hex');
  if (!process.env.AGENT_DEVICE_CORE_SPEC)
    console.log(`Core tarball sha256: ${await sha256(coreSpec)}`);
  console.log(`Plugin tarball sha256: ${await sha256(pluginTarball)}`);
  for (const directory of [consumer, project]) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'package.json'), '{"private":true,"type":"module"}');
  }
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', coreSpec], consumer);
  await run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', pluginTarball],
    project,
  );
  const manifest = JSON.parse(await fs.readFile(path.join(plugin, 'package.json'), 'utf8'));
  const installed = JSON.parse(
    await fs.readFile(path.join(project, 'node_modules', manifest.name, 'package.json'), 'utf8'),
  );
  assert.deepEqual(installed.exports, {
    ...fixture.additionalExports,
    '.': fixture.primaryExport ?? { import: './dist/agent-device.mjs' },
    './agent-device': fixture.primaryExport ?? { import: './dist/agent-device.mjs' },
  });
  // A plugin bundles its workspace code; it declares only what the fixture names as its own.
  assert.deepEqual(installed.dependencies, fixture.dependencies);
  assert.equal(installed.peerDependencies, undefined);
  await assert.rejects(fs.stat(path.join(project, 'node_modules', 'agent-device')), {
    code: 'ENOENT',
  });
  for (const subpath of Object.keys(fixture.additionalExports ?? {})) {
    const specifier = `${manifest.name}${subpath.slice(1)}`;
    await run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `await import(${JSON.stringify(specifier)}, ${JSON.stringify(
          subpath.endsWith('.json') ? { with: { type: 'json' } } : {},
        )});`,
      ],
      project,
    );
  }
  if (fixture.verifyTypes) {
    await run(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', pluginTarball],
      consumer,
    );
    await fixture.verifyTypes({ consumer, run, root });
    console.log(`Packed ${manifest.name}: TypeScript consumer passed.`);
  }
  await fs.writeFile(
    path.join(home, 'config.json'),
    JSON.stringify({ plugins: { [manifest.name]: { installation } } }),
  );
  const core = path.join(consumer, 'node_modules', 'agent-device');
  const coreManifest = JSON.parse(await fs.readFile(path.join(core, 'package.json'), 'utf8'));
  if (fixture.verifyPacked) {
    const pluginRoot = path.join(project, 'node_modules', manifest.name);
    const loadExport = async (directory, exports, name) =>
      await import(pathToFileURL(path.resolve(directory, exports[name].import)).href);
    await fixture.verifyPacked({
      core: await loadExport(core, coreManifest.exports, '.'),
      contracts: await loadExport(core, coreManifest.exports, './contracts'),
      plugin: await loadExport(pluginRoot, installed.exports, './agent-device'),
    });
    console.log(`Packed ${manifest.name}: failure contract passed.`);
  }
  const bin = path.resolve(core, coreManifest.bin['agent-device']);
  const env = {
    ...process.env,
    ...fixture.environment?.(endpoint),
    AGENT_DEVICE_HOME: home,
    AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1',
    AGENT_DEVICE_SESSION: 'provider-smoke',
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
  const connect = async () =>
    await command([
      'connect',
      fixture.provider,
      ...fixture.args,
      '--state-dir',
      path.join(scratch, 'state'),
    ]);
  if (fixture.respond) {
    const rejected = await connect();
    assert.equal(
      JSON.parse(rejected.stdout).error.code,
      'UNAUTHORIZED',
      rejected.stdout + rejected.stderr,
    );
    rejectCredentials = false;
  }
  const connected = await connect();
  assert.equal(connected.code, undefined, connected.stdout + connected.stderr);
  if (fixture.respond) assert.ok(requests.length > 0);
  console.log(
    `Packed ${manifest.name}: isolated install${fixture.respond ? ', host-recognized errors,' : ''} and CLI connect passed.`,
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(scratch, { recursive: true, force: true });
}
