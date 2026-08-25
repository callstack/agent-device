import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import {
  getManagedAgentBrowserStatus,
  runManagedAgentBrowser,
  setupManagedAgentBrowser,
} from './agent-browser-tool.ts';
import {
  installFakeManagedAgentBrowser,
  withNodeRuntime,
  writeFakeManagedAgentBrowserPackage,
  writeFakeNpmCliScript,
} from './__tests__/test-utils.ts';
import { AppError } from '@agent-device/kernel/errors';
import { withCommandExecutorOverride } from '../../utils/exec.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

type SpawnedCommand = { cmd: string; args: string[] };

test('managed agent-browser reports actionable guidance when install is missing', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-tool-');
  try {
    await assert.rejects(
      () => runManagedAgentBrowser(['doctor'], { stateDir, timeoutMs: 1_000 }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'TOOL_MISSING' &&
        error.details?.installDir === path.join(stateDir, 'tools', 'agent-browser', '0.27.1') &&
        error.details?.hint === expectedMissingInstallHint(),
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// The `node_modules/.bin` shim is a `.cmd` on Windows, which `child_process.spawn`
// rejects with EINVAL unless a shell is used (CVE-2024-27980 hardening). The
// fixture writes that shim, so this proves it exists and is still not the
// spawned command — including from an install path containing spaces.
test('managed agent-browser runs its JS entry with the current Node runtime, not the shim', async () => {
  const stateDir = mkdtempForTestSync('agent device web tool ');
  try {
    const install = installFakeManagedAgentBrowser(stateDir);
    const spawned: SpawnedCommand[] = [];

    await withCommandExecutorOverride(
      async (cmd, args) => {
        spawned.push({ cmd, args });
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async () =>
        await runManagedAgentBrowser(['snapshot', '--json'], { stateDir, timeoutMs: 1_000 }),
    );

    assert.ok(stateDir.includes(' '), 'the fixture must exercise a path containing spaces');
    assert.ok(fs.existsSync(install.binaryPath), 'the shim npm links must exist');
    assert.deepEqual(spawned, [
      { cmd: process.execPath, args: [install.entryScript, 'snapshot', '--json'] },
    ]);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('managed agent-browser passes the managed runtime home and socket dir to the backend', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-tool-');
  try {
    const install = installFakeManagedAgentBrowser(stateDir);
    let env: NodeJS.ProcessEnv | undefined;

    await withCommandExecutorOverride(
      async (_cmd, _args, options) => {
        env = options.env;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async () => await runManagedAgentBrowser(['doctor'], { stateDir, timeoutMs: 1_000 }),
    );

    assert.equal(env?.HOME, install.runtimeHomeDir);
    assert.equal(env?.AGENT_BROWSER_SOCKET_DIR, install.socketDir);
    assert.equal(env?.AGENT_BROWSER_IDLE_TIMEOUT_MS, '300000');
    assert.match(env?.AGENT_BROWSER_ARGS ?? '', /^--agent-device-managed-web=[a-f0-9]{16}$/);
    assert.notEqual(install.runtimeHomeDir, install.homeDir);
    assert.ok(fs.existsSync(install.runtimeHomeDir));
    assert.ok(fs.existsSync(install.socketDir));
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('managed agent-browser status ignores a bin shim without the backend package', () => {
  const stateDir = mkdtempForTestSync('agent-device-web-tool-');
  try {
    const installDir = path.join(stateDir, 'tools', 'agent-browser', '0.27.1');
    const binDir = path.join(installDir, 'package', 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'agent-browser'), '#!/bin/sh\nexit 0\n');
    fs.writeFileSync(path.join(binDir, 'agent-browser.cmd'), '@echo off\n');
    fs.writeFileSync(path.join(installDir, 'manifest.json'), '{}');

    const status = getManagedAgentBrowserStatus({ stateDir });

    assert.equal(status.entryScript, undefined);
    assert.equal(status.installed, false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// npm itself is `npm.cmd` on Windows, so setup runs npm's JS entry there. POSIX
// keeps spawning `npm` from PATH, which was never broken.
for (const scenario of [
  {
    name: 'posix keeps spawning npm from PATH',
    platform: 'linux' as const,
    advertiseNpm: false,
    bundleNpm: false,
    expected: 'bare-npm' as const,
  },
  {
    name: 'windows uses the npm launcher advertised through npm_execpath',
    platform: 'win32' as const,
    advertiseNpm: true,
    bundleNpm: false,
    expected: 'advertised' as const,
  },
  {
    name: 'windows falls back to the npm bundled beside node',
    platform: 'win32' as const,
    advertiseNpm: false,
    bundleNpm: true,
    expected: 'bundled' as const,
  },
  {
    name: 'windows without npm fails with actionable guidance',
    platform: 'win32' as const,
    advertiseNpm: false,
    bundleNpm: false,
    expected: 'missing' as const,
  },
]) {
  test(`managed agent-browser setup resolves npm: ${scenario.name}`, async () => {
    const stateDir = mkdtempForTestSync('agent device web setup ');
    try {
      const advertised = writeFakeNpmCliScript(path.join(stateDir, 'advertised'));
      const nodeDir = path.join(stateDir, 'Program Files', 'nodejs');
      const bundled = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (scenario.bundleNpm) {
        fs.mkdirSync(path.dirname(bundled), { recursive: true });
        fs.writeFileSync(bundled, 'process.exit(0)\n');
      }
      if (scenario.advertiseNpm) vi.stubEnv('npm_execpath', advertised);
      else vi.stubEnv('npm_execpath', '');
      const spawned: SpawnedCommand[] = [];

      await withNodeRuntime(
        { version: '24.13.0', platform: scenario.platform, execPath: path.join(nodeDir, 'node') },
        async () => {
          const run = async () =>
            await withCommandExecutorOverride(
              async (cmd, args) => {
                spawned.push({ cmd, args });
                if (args.includes('install') && args.includes('--prefix')) {
                  writeFakeManagedAgentBrowserPackage(stateDir);
                }
                return { stdout: '', stderr: '', exitCode: 0 };
              },
              async () => await setupManagedAgentBrowser({ stateDir }),
            );
          if (scenario.expected === 'missing') {
            await assert.rejects(
              run,
              (error: unknown) =>
                error instanceof AppError &&
                error.code === 'TOOL_MISSING' &&
                error.message === 'npm not found in PATH' &&
                typeof error.details?.hint === 'string',
            );
            return;
          }
          await run();
        },
      );

      if (scenario.expected === 'missing') {
        assert.deepEqual(spawned, [], 'no command may be spawned when npm cannot be resolved');
        return;
      }
      const npmSpawn = spawned[0];
      const expectedNpm = scenario.expected === 'advertised' ? advertised : bundled;
      if (scenario.expected === 'bare-npm') {
        assert.equal(npmSpawn?.cmd, 'npm');
        assert.equal(npmSpawn?.args[0], 'install');
      } else {
        assert.equal(npmSpawn?.cmd, path.join(nodeDir, 'node'));
        assert.equal(npmSpawn?.args[0], expectedNpm);
        assert.equal(npmSpawn?.args[1], 'install');
      }
      assert.deepEqual(npmSpawn?.args.slice(npmSpawn.args.indexOf('install')), [
        'install',
        '--prefix',
        path.join(stateDir, 'tools', 'agent-browser', '0.27.1', 'package'),
        '--no-global',
        '--no-audit',
        '--no-fund',
        '--no-save',
        'agent-browser@0.27.1',
      ]);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

test('managed agent-browser setup reports an install that produced no entry', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-setup-empty-');
  vi.stubEnv('npm_execpath', writeFakeNpmCliScript(stateDir));
  try {
    await withNodeRuntime({ version: '24.13.0' }, async () => {
      await withCommandExecutorOverride(
        // npm succeeds without writing the package, as an install redirected
        // out of the managed prefix would.
        async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        async () =>
          await assert.rejects(
            () => setupManagedAgentBrowser({ stateDir }),
            (error: unknown) =>
              error instanceof AppError &&
              error.code === 'TOOL_MISSING' &&
              error.message === 'Managed web backend install produced no runnable entry.',
          ),
      );
    });
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

function expectedMissingInstallHint(): string {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (nodeMajor < 24) {
    return `Web automation requires Node 24+; current Node is ${process.version}.`;
  }
  return 'Run `agent-device web setup` to install the managed web backend.';
}
