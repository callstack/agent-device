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
  const declarationPath = path.join(repoRoot, 'dist', 'src', 'android-adb.d.ts');
  if (fs.existsSync(declarationPath)) return;

  runCmdSync('pnpm', ['build'], {
    cwd: repoRoot,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
}

test('compiled SDK subpaths require explicit hosts', () => {
  ensureBuiltPackage();

  // Keep the fixture under the package root so TypeScript resolves the
  // package self-reference through package.json's compiled `types` export.
  const tempRoot = fs.mkdtempSync(path.join(repoRoot, '.tmp-sdk-host-types-'));
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
      `import { runAndroidShell, runAndroidExecOut } from 'agent-device/android-adb';
import { resolveAndroidArchivePackageName } from 'agent-device/artifacts';
import { prepareMetroRuntime } from 'agent-device/metro';
import { resolveRemoteConfigProfile } from 'agent-device/remote-config';
import { createLocalArtifactAdapter, type LocalArtifactAdapterOptions } from 'agent-device/io';

const host = { env: {}, cwd: '/workspace' };
declare const device: Parameters<typeof runAndroidShell>[0];
runAndroidShell(device, ['id'], host);
runAndroidExecOut(device, ['id'], host);
resolveAndroidArchivePackageName('app.apk', host);
prepareMetroRuntime({}, host);
resolveRemoteConfigProfile({ configPath: 'remote.json', ...host });
createLocalArtifactAdapter({ cwd: host.cwd });
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
      `The compiled agent-device SDK declarations no longer preserve the downstream contract:\n${result.stdout}${result.stderr}`,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('compiled plugin host declarations keep the provider-scoped facets', () => {
  ensureBuiltPackage();

  const tempRoot = fs.mkdtempSync(path.join(repoRoot, '.tmp-plugin-host-types-'));
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
  ProviderAndroidHost,
  ProviderAndroidTextInjectionRequest,
  ProviderPluginHost,
} from 'agent-device/plugins';

// The Apple facet a plugin's \`setup\` receives carries no daemon-wide Apple shutdown authority.
type AppleTools = NonNullable<ProviderPluginHost['apple']>['applicationTools'];
declare const appleTools: AppleTools;
void appleTools.resolveOpenTarget;
void appleTools.prepareRunner;
// @ts-expect-error handing runner sessions to the next daemon is not a plugin's authority.
void appleTools.detachRunnerSessionsForShutdown;
// @ts-expect-error stopping every runner session this process holds is not a plugin's authority.
void appleTools.finalizeRunnerSessionsForShutdown;

// The Android facet's binary contract is nameable without a Node buffer in either direction.
declare const android: ProviderAndroidHost;
const invocation = {
  target: { selector: { kind: 'unspecified' as const }, server: { kind: 'ambient' as const } },
  command: ['exec-out', 'screencap', '-p'],
};
const options = { binaryStdout: true, stdin: new Uint8Array([112, 105, 112, 101]) };
async function capture() {
  const result = await android.runAdb(invocation, options);
  // The platform's own answer, read as the contract names it: bytes, not a decoded string.
  const bytes: Uint8Array | undefined = result.stdoutBuffer;
  return bytes;
}
void capture();

function withTextEntry(text: (request: ProviderAndroidTextInjectionRequest) => Promise<void>) {
  return android.withAdbProvider({
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    text,
  }, 'provider-serial', async () => {});
}
void withTextEntry;

// The published facet carries no interactor operation. A plugin package bundles this declaration into
// its own copy, and an interactor's snapshot answer carries a brand no second copy answers to, so
// naming one here would make two plugin packages sharing one installed core stop typechecking. The
// composing root builds the interactor and names it on its own facet type, which no plugin imports.
// @ts-expect-error the published contract stays structural.
void android.createInteractor;
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
      `The compiled agent-device plugin host declarations no longer preserve the downstream contract:\n${result.stdout}${result.stderr}`,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
