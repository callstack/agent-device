import assert from 'node:assert/strict';
import type { AndroidAdbProvider } from '@agent-device/platform-android/mechanics';
import { deviceIdentity } from '@agent-device/kernel/device';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { WebProvider } from '@agent-device/platform-web';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deviceClaimFilePath } from '@agent-device/test-kit';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { ANDROID_IME_HELPER_FIXTURE_ARTIFACT } from '../../../src/__tests__/test-utils/android-ime-helper.ts';
import {
  ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
  androidSnapshotHelperOutput,
} from '../../../src/__tests__/test-utils/android-snapshot-helper.ts';
import { createProviderScenarioHarness, type ProviderScenarioRpcResult } from './harness.ts';
import { PROVIDER_SCENARIO_ANDROID, PROVIDER_SCENARIO_WEB } from './fixtures.ts';
import { androidSettingsXml } from './android-world.ts';

type HelpConformanceErrorResponse = {
  ok: false;
  error: {
    code: string;
    message: string;
    hint?: string;
    retriable?: boolean;
    details?: Record<string, unknown>;
  };
};

const checkoutNodes: RawSnapshotNode[] = [
  {
    index: 0,
    ref: 'e1',
    type: 'Window',
    role: 'window',
    label: 'Checkout',
    depth: 0,
    rect: { x: 0, y: 0, width: 390, height: 844 },
  },
  {
    index: 1,
    ref: 'e2',
    type: 'Button',
    role: 'button',
    label: 'Place order',
    hittable: true,
    enabled: true,
    depth: 1,
    parentIndex: 0,
    rect: { x: 20, y: 720, width: 350, height: 48 },
  },
];

const ambiguousNodes: RawSnapshotNode[] = [
  {
    index: 0,
    ref: 'e1',
    type: 'Window',
    role: 'window',
    label: 'Feed',
    depth: 0,
    rect: { x: 0, y: 0, width: 390, height: 844 },
  },
  ...[
    { index: 1, ref: 'e2' },
    { index: 4, ref: 'e5' },
    { index: 8, ref: 'e9' },
  ].map(({ index, ref }) => ({
    index,
    ref,
    type: 'Button',
    role: 'button',
    label: 'Follow',
    hittable: true,
    enabled: true,
    depth: 1,
    parentIndex: 0,
    rect: { x: 20, y: index * 40, width: 120, height: 32 },
  })),
];

function emptyWebProvider(nodes: () => RawSnapshotNode[]): WebProvider {
  return {
    async open() {},
    async close() {},
    async snapshot() {
      return { nodes: nodes(), truncated: false };
    },
    async screenshot() {},
    async setViewport() {},
    async click() {},
    async fill() {},
    async typeText() {},
    async scroll() {},
  };
}

function responseError(
  response: ProviderScenarioRpcResult,
  expectedCode: string,
  expectedStatus: number,
  label: string,
): HelpConformanceErrorResponse {
  assert.equal(response.statusCode, expectedStatus, `${label}: ${JSON.stringify(response.json)}`);
  const error = response.json?.error?.data;
  assert.equal(error?.code, expectedCode, `${label}: ${JSON.stringify(response.json)}`);
  assert.equal(typeof error?.message, 'string');
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(typeof error.hint === 'string' ? { hint: error.hint } : {}),
      ...(typeof error.retriable === 'boolean' ? { retriable: error.retriable } : {}),
      ...(error.details && typeof error.details === 'object'
        ? { details: error.details as Record<string, unknown> }
        : {}),
    },
  };
}

function androidAdbProvider(): AndroidAdbProvider {
  return {
    snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
    imeHelperArtifact: ANDROID_IME_HELPER_FIXTURE_ARTIFACT,
    exec: async (args) => {
      const command = args.join(' ');
      if (command === 'shell getprop sys.boot_completed') {
        return { stdout: '1\n', stderr: '', exitCode: 0 };
      }
      if (command === 'shell dumpsys window windows') {
        return {
          stdout: 'mCurrentFocus=Window{42 u0 com.android.settings/.Settings}\n',
          stderr: '',
          exitCode: 0,
        };
      }
      if (command.startsWith('shell am instrument ')) {
        return {
          stdout: androidSnapshotHelperOutput(androidSettingsXml('')),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
}

export async function captureHelpConformanceErrorRoutes(): Promise<{
  deviceInUse: HelpConformanceErrorResponse;
  deviceClaimInUse: HelpConformanceErrorResponse;
  staleRef: HelpConformanceErrorResponse;
  ambiguousMatch: HelpConformanceErrorResponse;
}> {
  let currentPage: 'checkout' | 'feed' = 'checkout';
  const webProvider = emptyWebProvider(() =>
    currentPage === 'checkout' ? checkoutNodes : ambiguousNodes,
  );
  let claimsDirectory: string | undefined;
  let ownerStateDirectory: string | undefined;
  const previousClaimsDirectory = process.env.AGENT_DEVICE_CLAIMS_DIR;
  let webDaemon: Awaited<ReturnType<typeof createProviderScenarioHarness>> | undefined;
  let androidDaemon: Awaited<ReturnType<typeof createProviderScenarioHarness>> | undefined;

  try {
    const activeClaimsDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'agent-device-help-conformance-'),
    );
    claimsDirectory = activeClaimsDirectory;
    const activeOwnerStateDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'agent-device-help-conformance-owner-'),
    );
    ownerStateDirectory = activeOwnerStateDirectory;
    process.env.AGENT_DEVICE_CLAIMS_DIR = activeClaimsDirectory;
    const activeWebDaemon = await createProviderScenarioHarness({
      deviceInventoryProvider: async (request) =>
        request.platform === 'web' ? [PROVIDER_SCENARIO_WEB] : [],
      webProvider: () => webProvider,
    });
    webDaemon = activeWebDaemon;

    const webOpen = async (session: string) => {
      currentPage = 'checkout';
      const response = await activeWebDaemon.callCommand(
        'open',
        ['https://example.test'],
        { platform: 'web' },
        { session },
      );
      assert.equal(response.json?.error, undefined, JSON.stringify(response.json));
    };

    await webOpen('checkout');
    const deviceInUse = responseError(
      await activeWebDaemon.callCommand(
        'open',
        ['https://example.test'],
        { platform: 'web' },
        { session: 'default' },
      ),
      'DEVICE_IN_USE',
      423,
      'session owns the selected web device',
    );

    const firstSnapshot = await activeWebDaemon.callCommand(
      'snapshot',
      [],
      { platform: 'web' },
      { session: 'checkout' },
    );
    const firstGeneration = firstSnapshot.json?.result?.data?.refsGeneration;
    assert.equal(typeof firstGeneration, 'number');
    const currentPress = await activeWebDaemon.callCommand(
      'press',
      [`@e2~s${firstGeneration}`],
      { platform: 'web' },
      { session: 'checkout' },
    );
    assert.equal(currentPress.json?.error, undefined, JSON.stringify(currentPress.json));
    const refreshedSnapshot = await activeWebDaemon.callCommand(
      'snapshot',
      [],
      { platform: 'web' },
      { session: 'checkout' },
    );
    const currentGeneration = refreshedSnapshot.json?.result?.data?.refsGeneration;
    assert.equal(typeof currentGeneration, 'number');
    assert.notEqual(currentGeneration, firstGeneration);
    const staleRefRaw = responseError(
      await activeWebDaemon.callCommand(
        'press',
        [`@e2~s${firstGeneration}`],
        { platform: 'web' },
        { session: 'checkout' },
      ),
      'COMMAND_FAILED',
      500,
      'superseded pinned ref',
    );
    assert.equal(staleRefRaw.error.details?.reason, 'ref_generation_mismatch');
    assert.equal(staleRefRaw.error.details?.mintedGeneration, firstGeneration);
    assert.equal(staleRefRaw.error.details?.currentGeneration, currentGeneration);
    const hint = staleRefRaw.error.hint;
    if (!hint) throw new Error('stale-ref route omitted its generation recovery hint');
    assert.ok(hint.includes(`s${firstGeneration}`));
    assert.ok(hint.includes(`s${currentGeneration}`));
    const staleRef = {
      ...staleRefRaw,
      error: {
        ...staleRefRaw.error,
        hint: hint.replace(`s${firstGeneration}`, 's5').replace(`s${currentGeneration}`, 's7'),
      },
    };

    currentPage = 'feed';
    const ambiguousSnapshot = await activeWebDaemon.callCommand(
      'snapshot',
      [],
      { platform: 'web' },
      { session: 'checkout' },
    );
    assert.equal(ambiguousSnapshot.json?.error, undefined, JSON.stringify(ambiguousSnapshot.json));
    const ambiguousMatch = responseError(
      await activeWebDaemon.callCommand(
        'find',
        ['text', 'Follow'],
        { platform: 'web' },
        { session: 'checkout' },
      ),
      'AMBIGUOUS_MATCH',
      500,
      'ambiguous Follow match',
    );

    const androidDevice = { ...PROVIDER_SCENARIO_ANDROID, name: 'Pixel' };
    const identity = deviceIdentity(androidDevice);
    const owner = readCurrentOwnerIdentity();
    fs.writeFileSync(
      deviceClaimFilePath('local:android:none:emulator-5554'),
      JSON.stringify({
        schemaVersion: 2,
        deviceKey: 'local:android:none:emulator-5554',
        device: { ...identity, name: androidDevice.name },
        session: 'checkout',
        workspace: '/worktrees/checkout',
        stateDir: activeOwnerStateDirectory,
        ownerPid: owner.pid,
        ownerStartTime: owner.startTime,
        ownerToken: 'help-conformance-owner',
        createdAtMs: 1,
        updatedAtMs: 1,
      }),
      'utf8',
    );
    androidDaemon = await createProviderScenarioHarness({
      androidAdbProvider,
      deviceInventoryProvider: async (request) =>
        request.platform === 'android' ? [androidDevice] : [],
    });
    const deviceClaimInUse = responseError(
      await androidDaemon.callCommand(
        'open',
        ['settings'],
        { platform: 'android', serial: androidDevice.id },
        { meta: { cwd: '/worktrees/other' } },
      ),
      'DEVICE_IN_USE',
      500,
      'cross-daemon device claim',
    );
    assert.match(deviceClaimInUse.error.message, /session "checkout"/);
    assert.match(deviceClaimInUse.error.message, /workspace "\/worktrees\/checkout"/);
    assert.equal(deviceClaimInUse.error.details?.reason, 'DEVICE_CLAIM_LIVE_OWNER');

    return { deviceInUse, deviceClaimInUse, staleRef, ambiguousMatch };
  } finally {
    try {
      await androidDaemon?.close();
    } finally {
      try {
        await webDaemon?.close();
      } finally {
        try {
          if (claimsDirectory) fs.rmSync(claimsDirectory, { recursive: true, force: true });
        } finally {
          try {
            if (ownerStateDirectory) {
              fs.rmSync(ownerStateDirectory, { recursive: true, force: true });
            }
          } finally {
            if (previousClaimsDirectory === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
            else process.env.AGENT_DEVICE_CLAIMS_DIR = previousClaimsDirectory;
          }
        }
      }
    }
  }
}
