import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  createIosSnapshotRequest,
  deriveIosCaptureHint,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import { createSnapshotSourceHost } from './host.ts';
import { createSimulatorSnapshotSource } from './adapter.ts';
import { DEPTH_HINT_PROBE_BACK_AFTER_USES } from './depth-hints.ts';
import {
  encodeSnapshotBridgeFrame,
  SNAPSHOT_SOURCE_PROTOCOL_VERSION,
  SNAPSHOT_SOURCE_VERSION,
} from './protocol.ts';
import type { SnapshotSourceHost, SnapshotSourceProcess, SnapshotSourceSocket } from './types.ts';

test('the Simulator AX source returns raw acquisition facts and discloses unsupported facets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-device-snapshot-adapter-'));
  const sourceRoot = path.join(root, 'source');
  const cacheRoot = path.join(root, 'cache');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  await writeFile(path.join(sourceRoot, 'SnapshotBridge.m'), 'native source');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeRuntime.m'), 'native runtime');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeRuntime.h'), 'native header');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeCapture.h'), 'native header');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeCapture.m'), 'native header');
  const fixture = createAdapterHost();
  const source = createSimulatorSnapshotSource({
    host: fixture.host,
    sourceRoot,
    cacheRoot,
    limits: { maxNodes: 20, maxTraversalDepth: 10, maxDurationMs: 1000 },
  });
  const request = createIosSnapshotRequest({ interactiveOnly: true });
  const hint = deriveIosCaptureHint(request);
  const sourceTarget = { ...targetForTest(), generation: 'generation-1' };

  try {
    const result = await source.acquire({
      target: { ...sourceTarget, targetId: 'target-1' },
      hint,
    });
    assert.equal(fixture.builds, 1);
    assert.equal(fixture.runs, 6);
    assert.equal(result.stage, 'acquired');
    assert.equal(result.acquisition.producer, 'simulator-ax-bridge');
    assert.equal(result.acquisition.intent, 'full');
    assert.deepEqual(result.acquisition.hint, hint);
    assert.equal(result.acquisition.nodes[0]?.pid, 321);
    assert.deepEqual(result.acquisition.viewport, {
      kind: 'reported',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    });
    assert.deepEqual(result.acquisition.lineage, {
      targetId: 'target-1',
      generation: 'generation-1',
    });
    assert.deepEqual(result.acquisition.residue, [
      { kind: 'unavailable-fact', fact: 'hittability' },
      { kind: 'unavailable-fact', fact: 'interactive-query' },
    ]);

    const regularDepthOne = await source.acquire({
      target: sourceTarget,
      hint: deriveIosCaptureHint(createIosSnapshotRequest({ depth: 1 })),
    });
    assert.equal(regularDepthOne.stage, 'acquired');
    assert.equal(fixture.requestedDepths.at(-1), 10);

    const rawDepthOne = await source.acquire({
      target: sourceTarget,
      hint: deriveIosCaptureHint(createIosSnapshotRequest({ raw: true, depth: 1 })),
    });
    assert.equal(rawDepthOne.stage, 'acquired');
    assert.equal(fixture.requestedDepths.at(-1), 1);
    assert.ok(rawDepthOne.acquisition.residue.some((item) => item.kind === 'truncated'));

    fixture.responsePid = 999;
    const outcome = await source.acquire({
      target: sourceTarget,
      hint,
    });
    assert.equal(outcome.stage, 'failed');
    if (outcome.stage === 'failed') assert.equal(outcome.failure.kind, 'stale-target');
    assert.equal(fixture.runs, 6);
  } finally {
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the Simulator AX source refuses a tree that ends at content another process owns', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-device-snapshot-adapter-remote-'));
  const sourceRoot = path.join(root, 'source');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  for (const name of [
    'SnapshotBridge.m',
    'SnapshotBridgeRuntime.m',
    'SnapshotBridgeRuntime.h',
    'SnapshotBridgeCapture.h',
    'SnapshotBridgeCapture.m',
  ]) {
    await writeFile(path.join(sourceRoot, name), 'native source');
  }
  const fixture = createAdapterHost();
  fixture.remoteContent = true;
  const source = createSimulatorSnapshotSource({
    host: fixture.host,
    sourceRoot,
    cacheRoot: path.join(root, 'cache'),
  });
  const target = { ...targetForTest(), generation: 'generation-1', targetId: 'target-1' };

  try {
    for (const request of [
      createIosSnapshotRequest(),
      createIosSnapshotRequest({ acquisitionIntent: 'surface-observation' }),
    ]) {
      const outcome = await source.acquire({ target, hint: deriveIosCaptureHint(request) });
      assert.equal(outcome.stage, 'failed');
      if (outcome.stage === 'failed') {
        assert.equal(outcome.failure.kind, 'unsupported');
        assert.equal(outcome.failure.code, 'remote-content-boundary');
        assert.equal(outcome.failure.details?.remoteElements, 1);
      }
    }
    // A refused tree teaches no depth hint: nothing about it validated.
    assert.deepEqual(fixture.diagnostics, []);

    fixture.remoteContent = false;
    const recovered = await source.acquire({
      target,
      hint: deriveIosCaptureHint(createIosSnapshotRequest()),
    });
    assert.equal(recovered.stage, 'acquired');
  } finally {
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('preparation consumes the same acquisition deadline as bridge I/O', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-device-snapshot-adapter-deadline-'));
  const sourceRoot = path.join(root, 'source');
  const cacheRoot = path.join(root, 'cache');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  await writeFile(path.join(sourceRoot, 'SnapshotBridge.m'), 'native source');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeRuntime.m'), 'native runtime');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeRuntime.h'), 'native header');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeCapture.h'), 'native header');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeCapture.m'), 'native header');
  const fixture = createAdapterHost(150);
  const source = createSimulatorSnapshotSource({ host: fixture.host, sourceRoot, cacheRoot });
  const request = createIosSnapshotRequest();
  const hint = deriveIosCaptureHint(request);

  try {
    const outcome = await source.acquire({
      target: { ...targetForTest(), generation: 'generation-1' },
      hint,
      limits: { maxDurationMs: 100 },
    });
    assert.equal(outcome.stage, 'failed');
    if (outcome.stage === 'failed') assert.equal(outcome.failure.kind, 'timeout');
    assert.equal(fixture.builds, 1);
  } finally {
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the Simulator AX source learns a hint only from a validated acquisition', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-device-snapshot-adapter-hints-'));
  const sourceRoot = path.join(root, 'source');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  for (const name of [
    'SnapshotBridge.m',
    'SnapshotBridgeRuntime.m',
    'SnapshotBridgeRuntime.h',
    'SnapshotBridgeCapture.h',
    'SnapshotBridgeCapture.m',
  ]) {
    await writeFile(path.join(sourceRoot, name), 'native source');
  }
  const fixture = createAdapterHost();
  fixture.rejectLevelsAbove = 4;
  const source = createSimulatorSnapshotSource({
    host: fixture.host,
    sourceRoot,
    cacheRoot: path.join(root, 'cache'),
    limits: { maxNodes: 20, maxTraversalDepth: 10, maxDurationMs: 1000 },
  });
  const hint = deriveIosCaptureHint(createIosSnapshotRequest());
  const target = { ...targetForTest(), targetId: 'target-1', generation: 'generation-1' };

  try {
    // A response with sound counters but an unusable tree fails acquisition and teaches nothing:
    // the next request of the same generation still asks for the full depth.
    fixture.malformedTree = true;
    const unusable = await source.acquire({ target, hint });
    assert.equal(unusable.stage, 'failed');
    if (unusable.stage === 'failed') assert.equal(unusable.failure.kind, 'malformed-tree');
    assert.equal(fixture.diagnostics.length, 0);
    fixture.malformedTree = false;

    // The first validated capture pays the rejection and learns; the next one sends the levels.
    assert.equal((await source.acquire({ target, hint })).stage, 'acquired');
    assert.equal((await source.acquire({ target, hint })).stage, 'acquired');
    assert.deepEqual(fixture.requestedHints, [undefined, undefined, 2]);
    assert.deepEqual(
      fixture.diagnostics.map((event) => [event.hint, event.rejected, event.learning]),
      [
        ['no-hint', 2, 'learned'],
        ['hinted', 0, 'kept'],
      ],
    );

    // A guest that stops reporting its request accounting is a malformed producer.
    fixture.omitRecovery = true;
    const unaccounted = await source.acquire({ target, hint });
    assert.equal(unaccounted.stage, 'failed');
    if (unaccounted.stage === 'failed') {
      assert.deepEqual(
        [unaccounted.failure.kind, unaccounted.failure.code],
        ['malformed-tree', 'recovery-invalid'],
      );
    }
  } finally {
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});

type HintStep = Readonly<{
  expire?: boolean;
  target?: Readonly<{ id: string; generation: string }>;
  explicitDepth?: boolean;
  expectHintBefore?: Readonly<Record<string, number | null>>;
  outcome?: Readonly<{
    failure?: string;
    rejected: Readonly<Record<string, number>>;
    acceptedLevels?: Readonly<Record<string, number>>;
    complete?: boolean;
  }>;
  expectHintAfter?: Readonly<Record<string, number | null>>;
  expectRenewed?: boolean;
}>;

const recoveryFixture = JSON.parse(
  readFileSync(
    path.resolve(
      import.meta.dirname,
      '../../../../contracts/fixtures/ios-ax-recovery-conformance.json',
    ),
    'utf8',
  ),
) as { version: number; hintCases: readonly { name: string; steps: readonly HintStep[] }[] };

type HintTarget = Readonly<{ targetId: string; generation: string }>;

/**
 * One hint case replayed through the source adapter: each step is one acquisition whose guest
 * rejects above the step's accepted levels and reports boundedness, and the hint the next request
 * carries is the observation. `expire` spends the count-based hint lifetime.
 */
class HintCaseReplay {
  private hintedUses = 0;
  private lastTarget: HintTarget | undefined;
  private readonly fixture: AdapterFixture;
  private readonly source: ReturnType<typeof createSimulatorSnapshotSource>;
  private readonly name: string;

  constructor(
    name: string,
    fixture: AdapterFixture,
    source: ReturnType<typeof createSimulatorSnapshotSource>,
  ) {
    this.name = name;
    this.fixture = fixture;
    this.source = source;
  }

  async step(step: HintStep): Promise<void> {
    if (step.expire) {
      await this.exhaust(this.lastTarget);
      return;
    }
    const target = { targetId: step.target!.id, generation: step.target!.generation };
    this.lastTarget = target;
    const outcome = step.outcome!;
    // A failing step is rejected at every depth; the guest gives up after its halving budget.
    this.fixture.rejectLevelsAbove = outcome.failure ? 0 : outcome.acceptedLevels!['host-bridge'];
    this.fixture.truncated = outcome.complete === false;
    const observed = await this.capture(
      target,
      step.explicitDepth ? explicitRawHint : regularHint,
      outcome.failure ? 'failed' : 'acquired',
    );
    assert.equal(observed.hint, expectedHint(step.expectHintBefore), `${this.name}: before`);
    this.assertObservedOutcome(observed.diagnostic, outcome);
    // The next capture of the same generation observes what the step taught.
    this.fixture.rejectLevelsAbove = undefined;
    const after = await this.capture(target);
    assert.equal(after.hint, expectedHint(step.expectHintAfter), `${this.name}: after`);
    if (step.expectRenewed === false) await this.assertNotRenewed(target);
  }

  /** A failed capture reports nothing; a validated one reports what the guest observed. */
  private assertObservedOutcome(
    diagnostic: Record<string, unknown> | undefined,
    outcome: NonNullable<HintStep['outcome']>,
  ): void {
    if (outcome.failure) {
      assert.equal(diagnostic, undefined, `${this.name}: a failed capture reports nothing`);
      return;
    }
    assert.equal(diagnostic?.rejected, outcome.rejected['host-bridge'], `${this.name}: rejected`);
    assert.equal(
      diagnostic?.acceptedLevels,
      outcome.acceptedLevels!['host-bridge'],
      `${this.name}: accepted`,
    );
    assert.equal(diagnostic?.truncated, outcome.complete === false, `${this.name}: bounded`);
  }

  private async assertNotRenewed(target: HintTarget): Promise<void> {
    const remaining = DEPTH_HINT_PROBE_BACK_AFTER_USES - this.hintedUses;
    assert.equal(
      await this.exhaust(target),
      remaining,
      `${this.name}: a hinted success must not renew the hint`,
    );
  }

  private async capture(
    target: HintTarget | undefined,
    hint = regularHint,
    expectedStage: 'acquired' | 'failed' = 'acquired',
  ) {
    assert.ok(target, `${this.name}: a capture needs a target`);
    const diagnosticsBefore = this.fixture.diagnostics.length;
    const outcome = await this.source.acquire({ target: { ...targetForTest(), ...target }, hint });
    assert.equal(outcome.stage, expectedStage, this.name);
    const sent = this.fixture.requestedHints.at(-1);
    if (sent !== undefined) this.hintedUses += 1;
    const diagnostic =
      this.fixture.diagnostics.length > diagnosticsBefore
        ? this.fixture.diagnostics.at(-1)
        : undefined;
    return { hint: sent, diagnostic };
  }

  /** Hinted captures until the owner probes back; returns how many hinted uses that spent. */
  private async exhaust(target: HintTarget | undefined): Promise<number> {
    const before = this.hintedUses;
    while ((await this.capture(target)).hint !== undefined) {
      assert.ok(
        this.hintedUses <= DEPTH_HINT_PROBE_BACK_AFTER_USES,
        `${this.name}: hints must expire`,
      );
    }
    return this.hintedUses - before;
  }
}

const regularHint = deriveIosCaptureHint(createIosSnapshotRequest());
const explicitRawHint = deriveIosCaptureHint(createIosSnapshotRequest({ raw: true, depth: 64 }));

function expectedHint(hints: Readonly<Record<string, number | null>> | undefined) {
  return hints?.['host-bridge'] ?? undefined;
}

test('the Simulator AX source follows the shared hint contract', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-device-snapshot-adapter-contract-'));
  const sourceRoot = path.join(root, 'source');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  for (const name of [
    'SnapshotBridge.m',
    'SnapshotBridgeRuntime.m',
    'SnapshotBridgeRuntime.h',
    'SnapshotBridgeCapture.h',
    'SnapshotBridgeCapture.m',
  ]) {
    await writeFile(path.join(sourceRoot, name), 'native source');
  }
  assert.equal(recoveryFixture.version, 1);
  try {
    for (const hintCase of recoveryFixture.hintCases) {
      const fixture = createAdapterHost();
      const source = createSimulatorSnapshotSource({
        host: fixture.host,
        sourceRoot,
        cacheRoot: path.join(root, 'cache', hintCase.name),
      });
      const replay = new HintCaseReplay(hintCase.name, fixture, source);
      for (const step of hintCase.steps) await replay.step(step);
      await source.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

type AdapterFixture = {
  host: SnapshotSourceHost;
  builds: number;
  runs: number;
  responsePid: number;
  requestedDepths: number[];
  requestedHints: (number | undefined)[];
  /** Native levels above which the fake guest reports a rejection-then-recovery. */
  rejectLevelsAbove: number | undefined;
  /** Whether the fake guest reports a depth- or node-bounded tree. */
  truncated: boolean;
  /** Whether the fake guest answers with sound counters but an unusable tree. */
  malformedTree: boolean;
  /** Whether the fake guest's tree ends at another process's content (a remote element leaf). */
  remoteContent: boolean;
  omitRecovery: boolean;
  diagnostics: Record<string, unknown>[];
};

function targetForTest() {
  return {
    udid: 'simulator-1',
    runtime: 'iOS 26.2',
    pid: 321,
  };
}

function createAdapterHost(buildDelayMs = 0): AdapterFixture {
  const realHost = createSnapshotSourceHost();
  const fixture: AdapterFixture = {
    host: undefined as never,
    builds: 0,
    runs: 0,
    responsePid: 321,
    requestedDepths: [],
    requestedHints: [],
    rejectLevelsAbove: undefined,
    truncated: false,
    malformedTree: false,
    remoteContent: false,
    omitRecovery: false,
    diagnostics: [],
  };
  const host: SnapshotSourceHost = {
    ...realHost,
    emitDiagnostic: (event) => {
      if (event.phase === 'ios_snapshot_source_recovery')
        fixture.diagnostics.push(event.data ?? {});
    },
    run: async (command, args) => {
      fixture.runs += 1;
      if (command === 'xcrun' && args.includes('clang')) {
        fixture.builds += 1;
        if (buildDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, buildDelayMs));
        await writeFile(args.at(-1)!, 'bridge-binary');
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return {
        stdout:
          command === 'xcodebuild'
            ? 'Xcode 16.4\nBuild version 16F6'
            : command === 'sw_vers'
              ? '15.6'
              : command === 'uname'
                ? 'arm64'
                : '26.2',
        stderr: '',
        exitCode: 0,
      };
    },
    start: () => new AdapterProcess(),
    connect: async () => new AdapterSocket(fixture),
    readTargetProcessStartTime: async () => 'target-start',
  };
  fixture.host = host;
  return fixture;
}

class AdapterProcess implements SnapshotSourceProcess {
  readonly pid = 801;
  readonly wait: Promise<{ stdout: string; stderr: string; exitCode: number }>;
  private resolveWait!: (result: { stdout: string; stderr: string; exitCode: number }) => void;
  private alive = true;

  constructor() {
    this.wait = new Promise((resolve) => {
      this.resolveWait = resolve;
    });
  }

  isAlive(): boolean {
    return this.alive;
  }

  signal(): void {
    this.alive = false;
    this.resolveWait({ stdout: '', stderr: '', exitCode: 0 });
  }

  readLog(): string {
    return '';
  }
}

class AdapterSocket extends EventEmitter implements SnapshotSourceSocket {
  destroyed = false;
  private readonly fixture: AdapterFixture;

  constructor(fixture: AdapterFixture) {
    super();
    this.fixture = fixture;
  }

  write(frame: Buffer): boolean {
    const bodyLength = frame.readUInt32BE(0);
    const request = JSON.parse(frame.subarray(4, bodyLength + 4).toString('utf8')) as {
      requestId: string;
      pid: number;
      generation: string;
      maxDepth: number;
      nativeLevelsHint?: number;
    };
    this.fixture.requestedDepths.push(request.maxDepth);
    this.fixture.requestedHints.push(request.nativeLevelsHint);
    // The guest's own recovery: halve a rejected depth at most twice, like SnapshotBridgeCapture.
    const requestedLevels = request.nativeLevelsHint ?? request.maxDepth + 1;
    const rejectAbove = this.fixture.rejectLevelsAbove;
    let acceptedLevels = requestedLevels;
    let rejected = 0;
    while (rejectAbove !== undefined && acceptedLevels > rejectAbove && rejected < 3) {
      rejected += 1;
      acceptedLevels = Math.max(1, Math.floor(acceptedLevels / 2));
    }
    const rejectedEverywhere = rejectAbove !== undefined && acceptedLevels > rejectAbove;
    queueMicrotask(() => {
      if (this.destroyed) return;
      if (rejectedEverywhere) {
        this.emit(
          'data',
          encodeSnapshotBridgeFrame(
            {
              protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
              sourceVersion: SNAPSHOT_SOURCE_VERSION,
              requestId: request.requestId,
              ok: false,
              pid: this.fixture.responsePid,
              generation: request.generation,
              error_kind: 'application_unavailable',
              error_code: 'application-server-unavailable',
            },
            { maxRequestBytes: 64 * 1024 },
          ),
        );
        return;
      }
      this.emit(
        'data',
        encodeSnapshotBridgeFrame(
          {
            protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
            sourceVersion: SNAPSHOT_SOURCE_VERSION,
            requestId: request.requestId,
            ok: true,
            pid: this.fixture.responsePid,
            generation: request.generation,
            truncated: request.maxDepth === 1 || this.fixture.truncated,
            automationEnabled: true,
            ...(this.fixture.omitRecovery
              ? {}
              : {
                  recovery: {
                    requests: 1 + rejected,
                    rejected,
                    continuations: 0,
                    acceptedLevels,
                  },
                }),
            tree: this.fixture.malformedTree
              ? null
              : {
                  XC_kAXXCAttributeElementType: 'Application',
                  XC_kAXXCAttributeFrame: { X: 0, Y: 0, Width: 390, Height: 844 },
                  XC_kAXXCAttributeChildren:
                    request.maxDepth === 1
                      ? [{ XC_kAXXCAttributeElementType: 'Button', XC_kAXXCAttributeChildren: [] }]
                      : this.fixture.remoteContent
                        ? [
                            {
                              XC_kAXXCAttributeElementType: 'WebView',
                              XC_kAXXCAttributeFrame: { X: 0, Y: 0, Width: 390, Height: 844 },
                              XC_kAXXCAttributeChildren: [
                                {
                                  XC_kAXXCAttributeElementType: 'AXRemoteElement',
                                  XC_kAXXCAttributeElementBaseType: 'NSObject',
                                  XC_kAXXCAttributeFrame: { X: 0, Y: 0, Width: 390, Height: 844 },
                                  XC_kAXXCAttributeChildren: [],
                                },
                              ],
                            },
                          ]
                        : [],
                },
          },
          {
            maxRequestBytes: 64 * 1024,
          },
        ),
      );
    });
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
  }
}
