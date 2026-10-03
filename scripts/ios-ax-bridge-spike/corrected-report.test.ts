import { describe, expect, test } from 'vitest';
import { buildCorrectedReport } from './corrected-report.ts';
import { renderCorrectedMarkdown } from './corrected-markdown.ts';
import { DEFAULT_SPIKE_LIMITS } from './limits.ts';
import type { TargetedRawArtifact, TargetedRecoveryProbe } from './corrected-types.ts';
import type { SpikeReport, SpikeResponse } from './types.ts';

const revision = { commit: 'abc123', branch: 'test', dirty: false } as const;
const mechanism = {
  implementation: 'idb',
  release: 'v1.5.2',
  companionArchive: 'idb-companion.macos-arm64.tar.gz',
  companionSha256: 'archive',
  guestBinary: 'Resources/SimulatorFrameworkBridge',
  guestBinaryExpectedSha256: 'guest',
  guestBinarySha256: 'guest',
  transport: 'socket',
  traversal: 'tree',
  client: 'node-direct-socket',
} as const;

describe('corrected Simulator AX bridge report', () => {
  test('counts retained generation evidence honestly and uses targeted readiness and resources', () => {
    const source = broadReport();
    const targeted = targetedArtifact();
    const report = buildCorrectedReport({
      sourcePath: 'broad.json.gz',
      source,
      targetedPath: 'targeted.json.gz',
      targeted,
    });

    expect(
      report.readiness.every(
        (cell) => cell.readinessObservedSamples === (cell.state === 'warm' ? 1 : 2),
      ),
    ).toBe(true);
    expect(report.hardGates.relaunch.status).toBe('PASS');
    expect(report.hardGates.boundedResources.status).toBe('PASS');
    expect(report.hardGates.liveRecovery.status).toBe('PASS');
    expect(report.hardGates.hierarchy.status).toBe('PASS');
    expect(report.decision).toBe('GO');
    expect(renderCorrectedMarkdown(report)).toContain('Decision: **GO**');
  });

  test('fails closed when a successful Node-direct read lacks resource metrics', () => {
    const targeted = targetedArtifact();
    const first = targeted.bootstrap[0]!;
    const report = buildCorrectedReport({
      sourcePath: 'broad.json.gz',
      source: broadReport(),
      targetedPath: 'targeted.json.gz',
      targeted: {
        ...targeted,
        bootstrap: [
          {
            ...first,
            response: {
              ...first.response,
              metrics: { ...first.response.metrics, cpuMs: null, memoryBytes: null },
            },
          },
          ...targeted.bootstrap.slice(1),
        ],
      },
    });

    expect(report.hardGates.boundedResources.status).toBe('FAIL');
    expect(report.decision).toBe('NO-GO');
  });

  test('fails relaunch when a timed read is not paired to its expected generation', () => {
    const targeted = targetedArtifact();
    const first = targeted.relaunch[0]!;
    const report = buildCorrectedReport({
      sourcePath: 'broad.json.gz',
      source: broadReport(),
      targetedPath: 'targeted.json.gz',
      targeted: {
        ...targeted,
        relaunch: [
          {
            ...first,
            response: successfulResponse('pid:999'),
          },
          ...targeted.relaunch.slice(1),
        ],
      },
    });

    expect(report.hardGates.relaunch.status).toBe('FAIL');
    expect(report.decision).toBe('NO-GO');
  });

  test('fails relaunch when the configured corpus is incomplete', () => {
    const targeted = targetedArtifact();
    const report = buildCorrectedReport({
      sourcePath: 'broad.json.gz',
      source: broadReport(),
      targetedPath: 'targeted.json.gz',
      targeted: { ...targeted, relaunch: targeted.relaunch.slice(1) },
    });

    expect(report.hardGates.relaunch.status).toBe('FAIL');
    expect(report.hardGates.relaunch.evidence).toContain('1/2 Node-direct samples');
  });
});

function broadReport(): SpikeReport {
  const samples = [
    { ok: true, firstTree: 'readable', wallClockMs: 40, target: 'pid:1' },
    { ok: true, firstTree: 'readable', wallClockMs: 60 },
  ] as const;
  return {
    revision,
    guestMechanism: mechanism,
    target: { udid: 'sim', name: 'simulator', runtime: 'iOS' },
    toolchain: {
      node: 'node',
      pnpm: 'pnpm',
      xcode: 'xcode',
      simctl: 'simctl',
      os: 'macOS',
      arch: 'arm64',
    },
    cells: (['warm', 'relaunch'] as const).map((state) => ({
      candidate: 'guest-simulator-framework-bridge',
      state,
      screen: 'list',
      acquisitionSamples: samples.map((sample) => ({
        ok: sample.ok,
        firstTree: sample.firstTree,
        wallClockMs: sample.wallClockMs,
        ...(sample.target
          ? { acquisition: { ...acquisition(), targetGeneration: sample.target } }
          : {}),
      })),
    })),
    decisionReasons: [],
    preferenceEvidence: {
      applied: true,
      restored: true,
      fixtureLaunchCompatible: true,
      simulatorStateBefore: 'Shutdown',
      diffs: [
        {
          changes: [
            { key: 'AutomationEnabled', before: 0, after: true },
            { key: 'IgnoreAXServerEntitlements', after: true },
          ],
        },
      ],
    },
  };
}

function targetedArtifact(): TargetedRawArtifact {
  const bootstrap = Array.from({ length: 5 }, (_, offset) => {
    const appPid = 100 + offset;
    return {
      index: offset + 1,
      durationMs: 100,
      usableTree: true,
      response: successfulResponse(`pid:${appPid}`),
      stderr: '',
      appPid,
      readinessMs: 50,
      readinessAttempts: 1,
      host: { loadAverage1m: 1, cpuCores: 12 },
    };
  });
  const operations = ['process-crash', 'timeout', 'cancelled', 'stale-generation'] as const;
  const recovery: TargetedRecoveryProbe[] = operations.map((operation) => ({
    operation,
    request: request(`request-${operation}`),
    response: {
      ...successfulResponse('pid:100'),
      ok: false,
      acquisition: undefined,
      failure: { kind: operation, code: 'probe' },
    },
    recoveredResponse: successfulResponse('pid:104'),
  }));
  const relaunch = Array.from({ length: 2 }, (_, offset) => {
    const appPid = 200 + offset;
    return {
      index: offset + 1,
      screen: 'list' as const,
      expectedAnchor: 'Item 20',
      appPid,
      readinessMs: 40,
      readinessAttempts: 1,
      durationMs: 80,
      response: successfulResponse(`pid:${appPid}`),
      stderr: '',
    };
  });
  return {
    schemaVersion: 'ios-simulator-ax-bridge-targeted.v3',
    generatedAt: '2026-09-03T00:00:00.000Z',
    revision,
    command: 'targeted',
    sourceArtifact: { path: 'broad.json.gz', revision, hostClient: 'legacy' },
    target: { udid: 'sim', name: 'simulator', runtime: 'iOS' },
    toolchain: {
      node: 'node',
      pnpm: 'pnpm',
      xcode: 'xcode',
      simctl: 'simctl',
      os: 'macOS',
      arch: 'arm64',
    },
    host: { loadAverage1m: 1, cpuCores: 12 },
    guestMechanism: mechanism,
    limits: DEFAULT_SPIKE_LIMITS,
    config: { states: ['warm', 'relaunch'], screens: ['list'], samples: 2, bootstrapSamples: 5 },
    bootstrap,
    relaunch,
    recovery,
  };
}

function successfulResponse(generation: string): SpikeResponse {
  return {
    version: 1,
    id: 'response',
    candidate: 'guest-simulator-framework-bridge',
    ok: true,
    acquisition: { ...acquisition(), targetGeneration: generation },
    metrics: {
      requestBytes: 100,
      responseBytes: 1_000,
      nodeCount: 2,
      maxTraversalDepth: 1,
      cpuMs: 20,
      memoryBytes: 10_000,
      durationMs: 100,
    },
  };
}

function acquisition() {
  return {
    targetId: 'simulator:sim',
    targetGeneration: 'pid:100',
    nodes: [{ id: 'root' }, { id: 'child', parentId: 'root' }],
    viewport: { kind: 'reported', rect: { x: 0, y: 0, width: 100, height: 100 } },
    truncated: false,
    residue: [],
  } as const;
}

function request(id: string) {
  return {
    version: 1,
    id,
    candidate: 'guest-simulator-framework-bridge',
    simulatorUdid: 'sim',
    state: 'warm',
    screen: 'list',
    limits: DEFAULT_SPIKE_LIMITS,
  } as const;
}
