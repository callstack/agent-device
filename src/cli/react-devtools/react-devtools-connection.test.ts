import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runReactProfileCommand } from './react-profile-command.ts';
import { commandHarness } from './react-devtools-command.fixtures.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const harness = () => commandHarness(runReactProfileCommand);

function bindSession(stateDir: string, controlBaseUrl: string) {
  fs.mkdirSync(path.join(stateDir, 'metro-sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'metro-sessions', 'qa.json'),
    JSON.stringify({ controlBaseUrl }),
  );
}

test('explicit dev-server flags override the session binding', async () => {
  const { run, requested } = harness();
  await run('start', '--metro-port', '8082');
  assert.deepEqual(requested, ['http://localhost:8082/json/list']);
});

test('the session Metro binding picks the dev server', async () => {
  const { run, requested, stateDir } = harness();
  fs.mkdirSync(path.join(stateDir, 'metro-sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'metro-sessions', 'qa.json'),
    JSON.stringify({ controlBaseUrl: 'http://127.0.0.1:19000/' }),
  );
  await run('start');
  assert.deepEqual(requested, ['http://127.0.0.1:19000/json/list']);
});

test('a remote bridge profiles through the public dev-server URL without its bundle path', async () => {
  const { run, requested, options } = harness();
  options.flags = {
    leaseBackend: 'android-instance',
    metroPublicBaseUrl: 'https://metro.example.test/index.bundle?platform=android',
  };
  await run('start');
  assert.deepEqual(requested, ['https://metro.example.test/json/list']);
});

test('a host flag on its own keeps the port of the session binding', async () => {
  const { run, requested, stateDir } = harness();
  bindSession(stateDir, 'http://127.0.0.1:19000/');
  await run('start', '--metro-host', '10.0.2.2');
  assert.deepEqual(requested, ['http://10.0.2.2:19000/json/list']);
});

test('a port that is not a whole number is refused before connecting', async () => {
  const { run, requested } = harness();
  await assert.rejects(run('start', '--metro-port', '8081oops'), /Invalid Metro port: 8081oops/);
  assert.deepEqual(requested, []);
});
