import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { runCliCapture } from './cli-capture.ts';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';
import {
  installFakeManagedAgentBrowser,
  withNodeRuntime,
  writeFakeManagedAgentBrowserPackage,
} from './test-utils/web-managed-agent-browser.ts';
import { withCommandExecutorOverride } from '@agent-device/host-kit/command';

type SpawnedCommand = { cmd: string; args: string[] };

// `binaryPath` has been in the published `web setup`/`web doctor` JSON since #833.
// The Windows spawn fix (#2022) moves execution to `node <entryScript>` and adds
// `entryScript`/`packageDir`, but the released field stays in the contract.
test('web doctor --json keeps the published status fields and spawns the JS entry', async () => {
  const stateDir = mkdtempForTestSync('agent device cli web doctor ');
  try {
    const install = await installFakeManagedAgentBrowser(stateDir);
    const spawned: SpawnedCommand[] = [];

    const result = await withCommandExecutorOverride(
      async (cmd, args) => {
        spawned.push({ cmd, args });
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      },
      async () =>
        await runCliCapture(['web', 'doctor', '--json'], {
          env: { AGENT_DEVICE_STATE_DIR: stateDir },
        }),
    );

    const status = parseStatus(result.stdout);
    assert.equal(status.binaryPath, install.binaryPath);
    assert.equal(status.entryScript, install.entryScript);
    assert.equal(status.packageDir, install.packageDir);
    assert.equal(status.installDir, install.installDir);
    assert.equal(status.installed, true);
    assert.equal(status.socketDir, undefined);
    assert.deepEqual(spawned, [
      { cmd: process.execPath, args: [install.entryScript, 'doctor', '--offline', '--quick'] },
    ]);
    assert.equal(result.calls.length, 0);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('web setup --json keeps the published status fields after installing', async () => {
  const stateDir = mkdtempForTestSync('agent device cli web setup ');
  try {
    let install: Awaited<ReturnType<typeof writeFakeManagedAgentBrowserPackage>> | undefined;
    let stdout = '';

    await withNodeRuntime({ version: '24.13.0' }, async () => {
      const result = await withCommandExecutorOverride(
        async (_cmd, args) => {
          // Stand in for the npm run that writes the managed package tree.
          if (args.includes('--prefix')) {
            install = await writeFakeManagedAgentBrowserPackage(stateDir);
          }
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        async () =>
          await runCliCapture(['web', 'setup', '--json'], {
            env: { AGENT_DEVICE_STATE_DIR: stateDir },
          }),
      );
      stdout = result.stdout;
    });

    const status = parseStatus(stdout);
    assert.equal(status.binaryPath, install?.binaryPath);
    assert.equal(status.entryScript, install?.entryScript);
    assert.equal(status.packageDir, install?.packageDir);
    assert.equal(status.installed, true);
    assert.equal(status.socketDir, undefined);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

function parseStatus(stdout: string): Record<string, unknown> {
  const payload: unknown = JSON.parse(firstJsonDocument(stdout));
  assert.ok(isRecord(payload) && payload.success === true, stdout);
  const data = payload.data;
  assert.ok(isRecord(data), stdout);
  const status = data.status;
  assert.ok(isRecord(status), stdout);
  return status;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The CLI dispatches `web` inside its top-level try, and the capture harness
 * turns `process.exit` into a throw, so the command's payload is followed by the
 * CLI's own report of that synthetic exit. Only the first document is the
 * command's own output; real runs exit for real and print it once.
 */
function firstJsonDocument(stdout: string): string {
  const lines = stdout.split('\n');
  const end = lines.indexOf('}');
  assert.ok(end >= 0, stdout);
  return lines.slice(0, end + 1).join('\n');
}
