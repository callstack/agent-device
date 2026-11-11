import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempWorkspace } from '@agent-device/test-kit';
import { runCliCapture } from './cli-capture.ts';

// #2161: the CLI hands the pin to the client, which checks the finished request. These runs go
// through argv parsing, remote and config defaults, and the batch writer to the transport.

function pinnedProject(config: Record<string, unknown>) {
  const workspace = makeTempWorkspace();
  // The CLI runs from the project directory, so the config path it reports is the resolved one.
  const configPath = path.join(fs.realpathSync(workspace.project), 'agent-device.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { ...workspace, configPath };
}

function readJsonError(stdout: string): { message: string; details: Record<string, unknown> } {
  const parsed = JSON.parse(stdout) as {
    error: { message: string; details: Record<string, unknown> };
  };
  return parsed.error;
}

test('a CLI batch step that names another device fails before any daemon request', async () => {
  const { root, home, project, configPath } = pinnedProject({
    platform: 'ios',
    device: 'iPad Pro',
    devicePin: true,
  });
  const steps = JSON.stringify([
    { command: 'open', input: { app: 'com.example.app', device: 'iPhone 16' } },
  ]);

  const result = await runCliCapture(['batch', '--steps', steps, '--json'], {
    cwd: project,
    env: { HOME: home },
  });

  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  const error = readJsonError(result.stdout);
  assert.equal(
    error.message,
    `Batch step 1: device "iPhone 16" conflicts with the device pin from project config file ${configPath}, which pins platform "ios", device "iPad Pro". Edit or remove "devicePin" in that config to target another device.`,
  );
  assert.equal(error.details.reason, 'device_pin_conflict');
  assert.deepEqual(error.details.conflicts, [
    { key: 'device', pinned: 'iPad Pro', requested: 'iPhone 16', step: 1 },
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a selector-less CLI open reaches the daemon with the pinned device', async () => {
  const { root, home, project } = pinnedProject({
    platform: 'ios',
    device: 'iPad Pro',
    devicePin: true,
  });

  const result = await runCliCapture(['open', 'com.example.app', '--json'], {
    cwd: project,
    env: { HOME: home },
  });

  assert.equal(result.calls[0]?.command, 'open');
  assert.equal(result.calls[0]?.flags?.platform, 'ios');
  assert.equal(result.calls[0]?.flags?.device, 'iPad Pro');
  fs.rmSync(root, { recursive: true, force: true });
});

test('--device-pin turns the configured defaults into a pin for one invocation', async () => {
  const { root, home, project } = pinnedProject({ platform: 'ios', device: 'iPad Pro' });

  const result = await runCliCapture(
    ['open', 'com.example.app', '--device-pin', '--device', 'iPhone 16', '--json'],
    { cwd: project, env: { HOME: home } },
  );

  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  const error = readJsonError(result.stdout);
  assert.equal(error.details.reason, 'device_pin_conflict');
  assert.equal(error.details.pinSource, 'the --device-pin flag');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a remote-config device that contradicts the pin fails before any daemon request', async () => {
  const { root, home, project } = pinnedProject({
    platform: 'ios',
    device: 'iPad Pro',
    devicePin: true,
  });
  const remoteConfig = path.join(project, 'device.remote.json');
  fs.writeFileSync(
    remoteConfig,
    JSON.stringify({
      daemonBaseUrl: 'http://remote-mac.example.test:9124/agent-device',
      tenant: 'acme',
      runId: 'run-1',
      leaseBackend: 'ios-instance',
      device: 'iPhone 16',
    }),
  );

  const result = await runCliCapture(
    ['snapshot', '--remote-config', remoteConfig, '--session', 'pinned', '--json'],
    { cwd: project, env: { HOME: home } },
  );

  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 0);
  assert.deepEqual(readJsonError(result.stdout).details.conflicts, [
    { key: 'device', pinned: 'iPad Pro', requested: 'iPhone 16' },
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});
