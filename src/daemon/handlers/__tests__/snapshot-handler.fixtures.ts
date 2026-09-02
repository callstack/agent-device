import path from 'node:path';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import { buildNodes } from '../../../__tests__/test-utils/snapshot-builders.ts';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { RawSnapshotNode, SnapshotNode } from '@agent-device/kernel/snapshot';
import { buildSnapshotSignatures } from '../../../snapshot/snapshot-freshness/index.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../request-runtime-binding.ts';
import { snapshotRuntimeFixture } from '../../__tests__/snapshot-runtime-fixture.ts';
import { SessionStore } from '../../session-store.ts';
import type { DaemonRequest, SessionState } from '../../types.ts';

export function makeSessionStore(): SessionStore {
  const root = mkdtempForTestSync('agent-device-snapshot-handler-');
  return new SessionStore(path.join(root, 'sessions'));
}

export function makeSession(
  name: string,
  device: SessionState['device'],
  extra?: Partial<SessionState>,
): SessionState {
  return { name, device, createdAt: Date.now(), actions: [], ...extra };
}

export function makeProviderRuntimeOwning(
  device: SessionState['device'],
  provider = 'browserstack',
): ProviderDeviceRuntime {
  return {
    provider,
    leaseLifecycle: {},
    deviceInventoryProvider: async () => [device],
    ownsDevice: (candidate) => candidate.id === device.id,
    getInteractor: () => undefined,
    shutdown: async () => undefined,
  };
}

export const iosSimulatorDevice: SessionState['device'] = {
  platform: 'apple',
  id: 'sim-1',
  name: 'My iPhone Simulator',
  kind: 'simulator',
  booted: true,
};

export const macOsDevice: SessionState['device'] = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host-macos-local',
  name: 'Host Mac',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

export const androidDevice: SessionState['device'] = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel 9 Pro XL',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

export const providerIosDevice: SessionState['device'] = {
  platform: 'apple',
  id: 'browserstack:ios:lease-a',
  name: 'iPhone 16',
  kind: 'device',
  target: 'mobile',
  booted: true,
};

/** A snapshot-route daemon request; the token is fixed for the whole suite. */
export function snapshotRequest(
  sessionName: string,
  command: DaemonRequest['command'],
  options: Partial<Pick<DaemonRequest, 'positionals' | 'flags' | 'internal'>> = {},
): DaemonRequest {
  return { token: 't', session: sessionName, command, positionals: [], flags: {}, ...options };
}

/**
 * The suite's snapshot runtime with a bind counter, so a test can assert whether the handler
 * bound the device at all (ADR 0019 §9: at most one bind per request).
 */
export function countingSnapshotRuntime(): Readonly<{
  inspectFacts: InspectDeviceRuntimeFacts;
  bindDevice: BindDeviceRuntime;
  bindCount: () => number;
}> {
  const runtime = snapshotRuntimeFixture();
  let bindCount = 0;
  const bindDevice: BindDeviceRuntime = async (device, use) => {
    bindCount += 1;
    return await runtime.bindDevice(device, use);
  };
  return { inspectFacts: runtime.inspectFacts, bindDevice, bindCount: () => bindCount };
}

export const inboxRow = (row: number): string => `Inbox row ${row}`;

/** `count` flat Android text rows as a capture returns them; `buildNodes` makes them a stored tree. */
export function androidTextRows(count: number, label: (row: number) => string): RawSnapshotNode[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    depth: 0,
    type: 'android.widget.TextView',
    label: label(index + 1),
  }));
}

export type AndroidCaptureAnalysis = { rawNodeCount: number; maxDepth: number };

/** What the Android capture double returns: an untruncated tree with optional backend analysis. */
export function androidCapture(
  nodes: readonly RawSnapshotNode[],
  analysis?: AndroidCaptureAnalysis,
): Record<string, unknown> {
  return { nodes, truncated: false, backend: 'android', ...(analysis ? { analysis } : {}) };
}

/**
 * An Android session whose stored tree is `baselineNodes`, still inside the freshness window a
 * recent `action` opened: the next capture is compared against that baseline before it is
 * trusted.
 */
export function makeAndroidFreshnessSession(
  name: string,
  action: 'press' | 'click',
  baselineNodes: SnapshotNode[],
): SessionState {
  const session = makeSession(name, androidDevice);
  session.snapshot = {
    nodes: baselineNodes,
    createdAt: Date.now(),
    backend: 'android',
    comparisonSafe: true,
  };
  session.androidSnapshotFreshness = {
    action,
    markedAt: Date.now(),
    baselineCount: baselineNodes.length,
    baselineSignatures: buildSnapshotSignatures(baselineNodes),
    routeComparable: true,
  };
  return session;
}

/** An inbox list, stored with refs, as the baseline a freshness window compares against. */
export function inboxBaselineNodes(count: number): SnapshotNode[] {
  return buildNodes(androidTextRows(count, inboxRow));
}

export const locationRequiredNodes: RawSnapshotNode[] = [
  {
    index: 0,
    depth: 0,
    type: 'android.widget.TextView',
    label: 'Location required',
    rect: { x: 24, y: 180, width: 342, height: 40 },
  },
  {
    index: 1,
    depth: 0,
    type: 'android.widget.Button',
    label: 'Dismiss',
    rect: { x: 24, y: 260, width: 342, height: 48 },
  },
];

/** The location-required surface as one capture. */
export function locationRequiredCapture(): Record<string, unknown> {
  return androidCapture(locationRequiredNodes, { rawNodeCount: 2, maxDepth: 0 });
}

/** A surface that shows only a Battery row, the #1270 wait target. */
export function batteryCapture(): Record<string, unknown> {
  return androidCapture(
    [
      {
        index: 0,
        depth: 0,
        type: 'android.widget.TextView',
        label: 'Battery',
        rect: { x: 252, y: 780, width: 153, height: 65 },
      },
    ],
    { rawNodeCount: 1, maxDepth: 0 },
  );
}
