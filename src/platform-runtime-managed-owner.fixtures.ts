import fs from 'node:fs';
import path from 'node:path';
import { runCmd } from '@agent-device/host-kit/command';
import { Deadline } from '@agent-device/host-kit/retry';
import { AppError } from '@agent-device/kernel/errors';
import type {
  ManagedLease,
  ManagedLeasePlatform,
} from '@agent-device/contracts/managed-device-allocation';
import { createManagedLeaseReachability } from './managed-device-reachability.ts';
import { createManagedLeaseAdmission } from './daemon/managed-device-allocation/lease-admission.ts';
import { createScriptedManagedDeviceAllocator } from './__tests__/test-utils/managed-device-allocator.fixtures.ts';
import {
  ALLOCATION_GRANTED_STATUS,
  ALLOCATION_LEASE,
  ALLOCATION_REQUEST,
} from './daemon/managed-device-allocation/__tests__/fixtures.ts';
import { managedGatewayScope } from './platform-runtime-gateway.fixtures.ts';
import { createComposedPlatformRuntimeGateway } from './platform-runtime-gateway.ts';
import { platformRuntimeModules } from './platform-runtime.ts';
import { createPlatformRuntimeHost } from './platform-runtime-operation-host.ts';
import { mkdtempForTestSync } from './__tests__/test-utils/tmp-dir.ts';
import './platform-runtime-android-adb-host.ts';

export const AUTOMATION_APP_ID = 'com.example.demo';
export const AUTOMATION_PNG = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex');

async function managedAutomationScope(platform: ManagedLeasePlatform) {
  const lease: ManagedLease = {
    ...ALLOCATION_LEASE,
    ttlDeadline: Date.now() + 60_000,
    device: { address: platform === 'ios' ? 'managed-ios' : 'emulator-15037' },
    environment:
      platform === 'ios'
        ? { SIMLOCK_IOS_DEVICE_SET: '/managed/set' }
        : { ANDROID_ADB_SERVER_PORT: '15037' },
  };
  const grant = { ...ALLOCATION_GRANTED_STATUS, lease };
  const allocator = createScriptedManagedDeviceAllocator({
    script: {
      requestLease: [grant],
      renewLease: [{ ...lease, ttlDeadline: Date.now() + 180_000 }],
    },
  });
  const reachability = createManagedLeaseReachability({ platform, lease });
  const admission = createManagedLeaseAdmission({
    allocator,
    reachability,
    grant: await allocator.requestLease({
      ...ALLOCATION_REQUEST,
      shape: { ...ALLOCATION_REQUEST.shape, platform },
    }),
    renewalSafetyWindowMs: 1_000,
  });
  const scope = managedGatewayScope(reachability.device, admission.owner, admission.fence);
  const horizon = { deadline: Deadline.fromTimeoutMs(90_000), teardownTimeoutMs: 1_000 };
  const managedScope = {
    ...scope,
    managedDevice: {
      ...scope.managedDevice!,
      run: reachability.run,
      ensureReady: async () => {
        const result = await admission.run(horizon, scope.signal, async () => {});
        if (result.status !== 'admitted')
          throw new AppError('COMMAND_FAILED', 'Managed lease refused.', { reason: result.status });
      },
    },
  };
  return { scope: managedScope, admission, allocator, device: reachability.device };
}

export async function managedAutomationBinding(platform: ManagedLeasePlatform) {
  const fixture = await managedAutomationScope(platform);
  const host = managedAutomationHost();
  const gateway = createComposedPlatformRuntimeGateway({
    modules: platformRuntimeModules,
    loadHost: async () => host,
    managedOwners: [fixture.admission.owner],
  });
  const binding = await gateway.bind({
    device: fixture.device,
    scope: fixture.scope,
    intent: { kind: 'exact-owner', owner: fixture.admission.owner, fence: fixture.admission.fence },
  });
  return { ...fixture, binding, host };
}

export async function managedAutomationApk(root: string): Promise<string> {
  fs.writeFileSync(
    path.join(root, 'AndroidManifest.xml'),
    `<manifest package="${AUTOMATION_APP_ID}" />`,
  );
  const apkPath = path.join(root, 'Demo.apk');
  await runCmd('zip', ['-q', apkPath, 'AndroidManifest.xml'], { cwd: root });
  return apkPath;
}

function managedAutomationHost() {
  const sessionsDir = mkdtempForTestSync('managed-automation-');
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected native lifecycle or durable resource operation');
  };
  const host = createPlatformRuntimeHost({
    sessionsDir,
    resolveSessionArtifacts: (sessionId) => ({
      outputPath: path.join(sessionsDir, sessionId, 'app.log'),
      pidPath: path.join(sessionsDir, sessionId, 'app-log.pid'),
    }),
    shutdownLoaders: { apple: unused, android: unused },
    snapshot: { captureSurface: unused, presentIosAcquisition: unused },
  });
  return {
    ...host,
    toolchains: { prepare: async () => {} },
    commands: { ...host.commands, run: unused },
    deviceReadiness: {
      ...host.deviceReadiness,
      appleAutomation: {
        keepHot: () => {
          throw new Error('Unexpected local boot');
        },
        markBooted: () => {},
        wasRecentlyObservedBooted: async () => false,
      },
      androidEmulator: {
        discover: unused,
        launch: () => {
          throw new Error('Unexpected emulator launch');
        },
        terminate: unused,
      },
    },
  };
}

export async function withManagedAdbFixture<T>(
  task: (fixture: { root: string; calls(): string[][] }) => Promise<T>,
): Promise<T> {
  const root = mkdtempForTestSync('managed-automation-adb-');
  const callPath = path.join(root, 'calls.jsonl');
  const adbPath = path.join(root, 'adb');
  fs.writeFileSync(
    adbPath,
    [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const args = process.argv.slice(2);',
      `fs.appendFileSync(${JSON.stringify(callPath)}, JSON.stringify(args) + '\\n');`,
      'if (args.includes("fingerprint")) { process.stderr.write("unknown command"); process.exit(1); }',
      'if (args.includes("screencap")) {',
      `  if (fs.existsSync(${JSON.stringify(path.join(root, 'corrupt-screenshot'))})) { process.stdout.write('invalid'); process.exit(0); }`,
      `  process.stdout.write(Buffer.from('${AUTOMATION_PNG.toString('hex')}', 'hex'));`,
      '} else if (args.includes("list") && args.includes("packages")) {',
      `  process.stdout.write('package:${AUTOMATION_APP_ID}\\n');`,
      '} else if (args.includes("clipboard") && args.includes("get")) {',
      '  process.stdout.write("managed clipboard");',
      '} else { process.stdout.write("Success"); }',
    ].join('\n'),
  );
  fs.chmodSync(adbPath, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${root}${path.delimiter}${previousPath ?? ''}`;
  try {
    return await task({
      root,
      calls: () =>
        fs.existsSync(callPath)
          ? fs
              .readFileSync(callPath, 'utf8')
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line))
          : [],
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}
