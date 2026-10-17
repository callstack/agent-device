import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { CliFlags } from '@agent-device/contracts/command';
import { mkdtempForTestSync, writeMetroSessionFixture } from '@agent-device/test-kit';
import { runReactDevtoolsCommand } from './react-devtools.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function harness() {
  const requested: string[] = [];
  const options: Parameters<typeof runReactDevtoolsCommand>[1] = {
    stateDir: mkdtempForTestSync('react-devtools-cli-'),
    session: 'qa',
  };
  vi.stubGlobal('fetch', async (url: URL) => {
    requested.push(String(url));
    return new Response('[]', { status: 200 });
  });
  const run = async (...args: string[]) =>
    await runReactDevtoolsCommand(['profile', ...args], options);
  return { run, options, stateDir: options.stateDir, requested };
}

test('explicit dev-server flags override the session binding', async () => {
  const { run, requested } = harness();
  await assert.rejects(run('start', '--metro-port', '8082'), /No React Native runtime/);
  assert.deepEqual(requested, ['http://localhost:8082/json/list']);
});

test('the session Metro binding picks the dev server', async () => {
  const { run, requested, stateDir } = harness();
  writeMetroSessionFixture({
    stateDir,
    session: 'qa',
    hints: { controlBaseUrl: 'http://127.0.0.1:19000/' },
  });
  await assert.rejects(run('start'), /No React Native runtime/);
  assert.deepEqual(requested, ['http://127.0.0.1:19000/json/list']);
});

test('a remote bridge without a Metro binding stays on the local dev server, not the public URL', async () => {
  const { run, requested, options } = harness();
  const flags: Partial<CliFlags> = {
    leaseBackend: 'android-instance',
    metroPublicBaseUrl: 'https://metro.example.test/index.bundle?platform=android',
  };
  options.flags = flags;
  await assert.rejects(run('start'), /No React Native runtime/);
  assert.deepEqual(requested, ['http://localhost:8081/json/list']);
});

test('a host flag on its own keeps the port of the session binding', async () => {
  const { run, requested, stateDir } = harness();
  writeMetroSessionFixture({
    stateDir,
    session: 'qa',
    hints: { controlBaseUrl: 'http://127.0.0.1:19000/' },
  });
  await assert.rejects(run('start', '--metro-host', '10.0.2.2'), /No React Native runtime/);
  assert.deepEqual(requested, ['http://10.0.2.2:19000/json/list']);
});

test('a port that is not a whole number is refused before connecting', async () => {
  const { run, requested } = harness();
  await assert.rejects(run('start', '--metro-port', '8081oops'), /Invalid Metro port: 8081oops/);
  assert.deepEqual(requested, []);
});
