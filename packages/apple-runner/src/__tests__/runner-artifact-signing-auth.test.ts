import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { appleRunnerTestHost } from '../test-host.ts';
import { ensureXctestrunArtifact } from '../runner-xctestrun.ts';
import { IOS_DEVICE } from './device-fixtures.ts';
import { seedBuiltRunner, restoreEnvVar } from './runner-xctestrun.fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

// The build-time ASC API key trio (#4961): the trichotomy is proven at the spawn seam, so the
// tests read the exact argv `xcodebuild` receives rather than the resolvers above it. The none-set
// case pins the whole device-build invocation byte for byte (scratch paths normalized), which is
// the pre-change constructor output.

const AUTH_KEY_ENV_NAMES = [
  'AGENT_DEVICE_IOS_AUTH_KEY_PATH',
  'AGENT_DEVICE_IOS_AUTH_KEY_ID',
  'AGENT_DEVICE_IOS_AUTH_KEY_ISSUER_ID',
];

/** Every env var that would steer the invocation away from its unpinned shape. */
const INVOCATION_ENV_NAMES = [
  ...AUTH_KEY_ENV_NAMES,
  'AGENT_DEVICE_IOS_TEAM_ID',
  'AGENT_DEVICE_IOS_SIGNING_IDENTITY',
  'AGENT_DEVICE_IOS_PROVISIONING_PROFILE',
  'AGENT_DEVICE_IOS_BUNDLE_ID',
  'AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID',
  'AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID',
  'AGENT_DEVICE_XCUITEST_ARCHS',
  'AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS',
  'AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET',
];

const runCmdStreaming = vi.fn();
let projectRoot: string;
let derived: string;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  projectRoot = mkdtempForTestSync('agent-device-signing-auth-root-');
  fs.mkdirSync(
    path.join(projectRoot, 'apple', 'runner', 'AgentDeviceRunner', 'AgentDeviceRunner.xcodeproj'),
    { recursive: true },
  );
  derived = mkdtempForTestSync('agent-device-signing-auth-derived-');
  for (const name of INVOCATION_ENV_NAMES) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH = derived;
  runCmdStreaming.mockReset();
  appleRunnerTestHost.update({
    runCmdStreaming,
    findProjectRoot: () => projectRoot,
    readVersion: () => '0.0.0-test',
  });
});

afterEach(() => {
  delete process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH;
  for (const [name, value] of savedEnv) {
    restoreEnvVar(name, value);
  }
  savedEnv.clear();
});

function setAuthKeyTrio(): string {
  const keyFile = path.join(projectRoot, 'AuthKey_ABCDEF1234.p8');
  fs.writeFileSync(keyFile, '-----BEGIN PRIVATE KEY-----\n');
  process.env.AGENT_DEVICE_IOS_AUTH_KEY_PATH = keyFile;
  process.env.AGENT_DEVICE_IOS_AUTH_KEY_ID = 'KID12345';
  process.env.AGENT_DEVICE_IOS_AUTH_KEY_ISSUER_ID = 'ISSUER67890';
  return keyFile;
}

function capturedArgs(): string[] {
  assert.equal(runCmdStreaming.mock.calls.length, 1, 'the build was spawned once');
  const [command, args] = runCmdStreaming.mock.calls[0] as unknown as [string, string[]];
  assert.equal(command, 'xcodebuild');
  return args;
}

test('a device build with the whole auth key trio passes the three authentication key args', async () => {
  const keyFile = setAuthKeyTrio();
  runCmdStreaming.mockImplementation(async (_command: string, args: string[]) => {
    await seedBuiltRunner(args);
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  await ensureXctestrunArtifact(IOS_DEVICE, {});

  const args = capturedArgs();
  const provisioningIndex = args.indexOf('-allowProvisioningUpdates');
  assert.notEqual(provisioningIndex, -1, 'the device build carries -allowProvisioningUpdates');
  assert.deepEqual(args.slice(provisioningIndex, provisioningIndex + 7), [
    '-allowProvisioningUpdates',
    '-authenticationKeyPath',
    keyFile,
    '-authenticationKeyID',
    'KID12345',
    '-authenticationKeyIssuerID',
    'ISSUER67890',
  ]);
});

test('a device build with a partial auth key trio refuses before xcodebuild runs', async () => {
  process.env.AGENT_DEVICE_IOS_AUTH_KEY_PATH = '/keys/AuthKey_ABCDEF1234.p8';
  process.env.AGENT_DEVICE_IOS_AUTH_KEY_ID = 'KID12345';

  const failure = await ensureXctestrunArtifact(IOS_DEVICE, {}).catch((error: unknown) => error);

  assert.ok(failure instanceof AppError, 'the refusal is an AppError');
  assert.equal(failure.details?.reason, 'signing_auth_key_incomplete');
  assert.deepEqual(failure.details?.missingEnv, ['AGENT_DEVICE_IOS_AUTH_KEY_ISSUER_ID']);
  assert.match(String(failure.details?.hint), /AGENT_DEVICE_IOS_AUTH_KEY_ISSUER_ID/);
  assert.equal(runCmdStreaming.mock.calls.length, 0, 'no build was spawned');
});

test('a device build with an unreadable auth key file refuses before xcodebuild runs', async () => {
  const keyFile = path.join(projectRoot, 'AuthKey_UNREADABLE.p8');
  fs.writeFileSync(keyFile, '-----BEGIN PRIVATE KEY-----\n', { mode: 0o000 });
  process.env.AGENT_DEVICE_IOS_AUTH_KEY_PATH = keyFile;
  process.env.AGENT_DEVICE_IOS_AUTH_KEY_ID = 'KID12345';
  process.env.AGENT_DEVICE_IOS_AUTH_KEY_ISSUER_ID = 'ISSUER67890';

  const failure = await ensureXctestrunArtifact(IOS_DEVICE, {}).catch((error: unknown) => error);

  assert.ok(failure instanceof AppError, 'the refusal is an AppError');
  assert.equal(failure.details?.reason, 'signing_auth_key_invalid_path');
  assert.equal(failure.details?.envName, 'AGENT_DEVICE_IOS_AUTH_KEY_PATH');
  const rendered = JSON.stringify(failure);
  assert.equal(rendered.includes(keyFile), false, 'the value never reaches the error');
  assert.equal(
    /EACCES|EPERM|Operation not permitted/.test(rendered),
    false,
    'the raw filesystem error never reaches the error',
  );
  assert.equal(runCmdStreaming.mock.calls.length, 0, 'no build was spawned');
});

test('a device build without the auth key trio keeps the pre-change invocation byte for byte', async () => {
  runCmdStreaming.mockImplementation(async (_command: string, args: string[]) => {
    await seedBuiltRunner(args);
    return { exitCode: 0, stdout: '', stderr: '' };
  });

  await ensureXctestrunArtifact(IOS_DEVICE, {});

  const args = capturedArgs();
  assert.equal(
    args.filter((arg) => arg.includes('authenticationKey')).length,
    0,
    'no authentication key arg without the env trio',
  );
  // The one volatile part of the recipe is the per-build products directory name; normalize the
  // three scratch roots so the rest of the argv is compared to the pinned pre-change bytes.
  const symroot = args.find((arg) => arg.startsWith('SYMROOT='))!.slice('SYMROOT='.length);
  const normalized = args.map((arg) =>
    arg.replaceAll(symroot, '<products>').replaceAll(derived, '<derived>'),
  );
  assert.deepEqual(normalized, [
    'build-for-testing',
    '-project',
    path.join(projectRoot, 'apple', 'runner', 'AgentDeviceRunner', 'AgentDeviceRunner.xcodeproj'),
    '-scheme',
    'AgentDeviceRunner',
    '-parallel-testing-enabled',
    'NO',
    '-maximum-concurrent-test-device-destinations',
    '1',
    '-destination',
    'generic/platform=iOS',
    '-derivedDataPath',
    '<derived>',
    'SYMROOT=<products>',
    'OBJROOT=<derived>/Build/Intermediates.noindex',
    'SHARED_PRECOMPS_DIR=<derived>/Build/Intermediates.noindex/PrecompiledHeaders',
    'COMPILER_INDEX_STORE_ENABLE=NO',
    'ENABLE_CODE_COVERAGE=NO',
    'ONLY_ACTIVE_ARCH=YES',
    'ENABLE_PREVIEWS=NO',
    'ENABLE_DEBUG_DYLIB=NO',
    '-IDEPackageSupportDisableManifestSandbox=1',
    '-IDEPackageSupportDisablePluginExecutionSandbox=1',
    'ENABLE_USER_SCRIPT_SANDBOXING=NO',
    'OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox -D AGENT_DEVICE_RUNNER_ISOLATION_CANARY',
    'AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID=com.callstack.agentdevice.runner',
    'AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID=com.callstack.agentdevice.runner.uitests',
    '-allowProvisioningUpdates',
    'CODE_SIGN_STYLE=Automatic',
  ]);
});
