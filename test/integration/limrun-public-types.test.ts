import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCmdSync } from '@agent-device/host-kit/command';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSC_BIN = path.join(repoRoot, 'node_modules/.bin/tsc');
const COMMAND_TIMEOUT_MS = 120_000;

function ensureBuiltPackage(): void {
  const declarationPath = path.join(repoRoot, 'dist', 'src', 'limrun.d.ts');
  if (fs.existsSync(declarationPath)) return;

  runCmdSync('pnpm', ['build'], {
    cwd: repoRoot,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
}

test('compiled SDK subpaths require explicit hosts and preserve Limrun types', () => {
  ensureBuiltPackage();

  // Keep the fixture under the package root so TypeScript resolves the
  // package self-reference through package.json's compiled `types` export.
  const tempRoot = fs.mkdtempSync(path.join(repoRoot, '.tmp-limrun-types-'));
  try {
    fs.writeFileSync(
      path.join(tempRoot, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            noEmit: true,
            strict: true,
            types: ['node'],
          },
          include: ['fixture.ts'],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(tempRoot, 'fixture.ts'),
      `import type {
  LimrunDeviceSession,
  LimrunIosCommandExecution,
  LimrunIosDeviceSession,
  LimrunRuntimeOptions,
} from 'agent-device/limrun';
import { LimrunRuntime } from 'agent-device/limrun';
import { runAndroidShell, runAndroidExecOut } from 'agent-device/android-adb';
import { resolveAndroidArchivePackageName } from 'agent-device/artifacts';
import { prepareMetroRuntime } from 'agent-device/metro';
import { resolveRemoteConfigProfile } from 'agent-device/remote-config';
import { createLocalArtifactAdapter, type LocalArtifactAdapterOptions } from 'agent-device/io';

declare const runtime: LimrunRuntime;
declare const options: LimrunRuntimeOptions;
declare const session: LimrunDeviceSession;
declare const iosSession: LimrunIosDeviceSession;
declare const execution: LimrunIosCommandExecution;
void [runtime, options, session, iosSession, execution];
const host = { env: {}, cwd: '/workspace' };
declare const device: Parameters<typeof runAndroidShell>[0];
runAndroidShell(device, ['id'], host);
runAndroidExecOut(device, ['id'], host);
resolveAndroidArchivePackageName('app.apk', host);
prepareMetroRuntime({}, host);
resolveRemoteConfigProfile({ configPath: 'remote.json', ...host });
createLocalArtifactAdapter({ cwd: host.cwd });
new LimrunRuntime(options, host);
// @ts-expect-error Android shell requires a host.
runAndroidShell(device, ['id']);
// @ts-expect-error Android exec-out requires a host.
runAndroidExecOut(device, ['id']);
// @ts-expect-error Archive inspection requires a host.
resolveAndroidArchivePackageName('app.apk');
// @ts-expect-error Metro requires a host.
prepareMetroRuntime({});
// @ts-expect-error Remote config requires env, including when it is empty.
resolveRemoteConfigProfile({ configPath: 'remote.json', cwd: host.cwd });
// @ts-expect-error Local artifact I/O requires cwd.
createLocalArtifactAdapter();
// @ts-expect-error Local artifact options require cwd.
const missingCwd: LocalArtifactAdapterOptions = {};
void missingCwd;
// @ts-expect-error Limrun requires a host.
new LimrunRuntime(options);
`,
    );

    const result = runCmdSync(
      TSC_BIN,
      ['--noEmit', '-p', path.join(tempRoot, 'tsconfig.json'), '--pretty', 'false'],
      {
        cwd: tempRoot,
        timeoutMs: COMMAND_TIMEOUT_MS,
        allowFailure: true,
      },
    );

    assert.equal(
      result.exitCode,
      0,
      `The compiled agent-device/limrun declarations no longer preserve the downstream contract:\n${result.stdout}${result.stderr}`,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
