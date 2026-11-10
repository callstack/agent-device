import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  createIosSnapshotRequest,
  deriveIosCaptureHint,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import { createSimulatorSnapshotSource } from './adapter.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../core/tool-provider.ts';
import { readSnapshotTargetProcessStartTime } from '../snapshot-process.ts';
import { DEPTH_HINT_PROBE_BACK_AFTER_USES } from './depth-hints.ts';
import { SNAPSHOT_BRIDGE_SOURCE_FILENAMES } from './cache-identity.ts';
import { ADAPTER_KEYBOARD_CASES } from './adapter-keyboard.fixtures.ts';
import type { SnapshotSourceOutcome } from '@agent-device/capture-kit/snapshot-source-channel';
import { createAdapterHost, targetForTest, type AdapterFixture } from './adapter.fixtures.ts';
import { mkdtempForTest } from '../__tests__/tmp-dir.ts';

test('the Simulator AX source returns raw acquisition facts and discloses unsupported facets', async () => {
  const root = await mkdtempForTest('agent-device-snapshot-adapter-');
  const sourceRoot = path.join(root, 'source');
  const cacheRoot = path.join(root, 'cache');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  for (const name of SNAPSHOT_BRIDGE_SOURCE_FILENAMES) {
    await writeFile(path.join(sourceRoot, name), 'native source');
  }
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
      target: {
        ...targetForTest('/tmp/scoped-set'),
        generation: 'generation-1',
        targetId: 'target-1',
      },
      hint,
    });
    assert.deepEqual(
      fixture.startedTargets.map((started) => started.simulatorSetPath),
      ['/tmp/scoped-set'],
    );
    assert.equal(fixture.builds, 1);
    // Three identity probes and one clang build: the identity read execs one Xcode-owned binary.
    assert.equal(fixture.runs, 4);
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
    // With the viewport reported the reader owns `hittable` and stamps it on every node, so hittability
    // is not disclosed as unavailable; only the interactive-query facet it cannot honour is.
    assert.deepEqual(result.acquisition.residue, [
      { kind: 'unavailable-fact', fact: 'interactive-query' },
    ]);
    assert.equal(result.acquisition.nodes[0]?.hittable, false, 'the stamped root is not hittable');

    // The complement (#2199: the residue owner is the fact owner): strip the viewport and the reader
    // publishes no `hittable` claim and discloses hittability as unavailable again.
    fixture.omitViewport = true;
    const viewportless = await source.acquire({
      target: { ...sourceTarget, targetId: 'target-1' },
      hint,
    });
    fixture.omitViewport = false;
    assert.equal(viewportless.stage, 'acquired');
    assert.equal(viewportless.acquisition.nodes[0]?.hittable, undefined);
    assert.deepEqual(viewportless.acquisition.residue, [
      { kind: 'unavailable-fact', fact: 'hittability' },
      { kind: 'unavailable-fact', fact: 'interactive-query' },
      { kind: 'missing-viewport', reason: 'not-provided' },
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
    assert.equal(fixture.runs, 4);
  } finally {
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the Simulator AX source refuses a tree that ends at content another process owns', async () => {
  const root = await mkdtempForTest('agent-device-snapshot-adapter-remote-');
  const sourceRoot = path.join(root, 'source');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  for (const name of SNAPSHOT_BRIDGE_SOURCE_FILENAMES) {
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

// #2751: the check rides on the bridge request, so an acquisition spawns no surface probe. What it
// still spawns is the target's two `ps` identity reads around the request, which guard pid reuse.
test('the Simulator AX source asks the guest for running surface hosts only when told to', async () => {
  const root = await mkdtempForTest('agent-device-snapshot-adapter-surface-');
  const sourceRoot = path.join(root, 'source');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  for (const name of SNAPSHOT_BRIDGE_SOURCE_FILENAMES) {
    await writeFile(path.join(sourceRoot, name), 'native source');
  }
  const fixture = createAdapterHost();
  fixture.runningSurfaceHost = true;
  const source = createSimulatorSnapshotSource({
    // The production identity read, so its host processes reach the tool provider below.
    host: { ...fixture.host, readTargetProcessStartTime: readSnapshotTargetProcessStartTime },
    sourceRoot,
    cacheRoot: path.join(root, 'cache'),
  });
  const target = { ...targetForTest(), generation: 'generation-1', targetId: 'target-1' };
  const hint = deriveIosCaptureHint(createIosSnapshotRequest());
  const surfaceHostExecutables = ['SafariViewService.app/SafariViewService'];
  const runCommand = vi.fn(async () => ({ stdout: 'target-start', stderr: '', exitCode: 0 }));

  try {
    const identityRead = ['ps', ['-p', String(target.pid), '-o', 'lstart='], expect.anything()];
    const [unchecked, refused] = await withAppleToolProvider(
      createLocalAppleToolProvider({ runCommand }),
      async () => {
        const acquired = await source.acquire({ target, hint });
        // One read before the request and one after the tree, and no other host process.
        expect(runCommand.mock.calls).toEqual([identityRead, identityRead]);
        runCommand.mockClear();
        const refusal = await source.acquire({ target, hint, surfaceHostExecutables });
        // A refusal returns no tree, so the read after it never runs.
        expect(runCommand.mock.calls).toEqual([identityRead]);
        return [acquired, refusal];
      },
    );

    assert.equal(unchecked.stage, 'acquired');
    assert.equal(refused.stage, 'failed');
    if (refused.stage === 'failed') {
      assert.equal(refused.failure.kind, 'unsupported');
      assert.equal(refused.failure.code, 'system-surface-host-present');
      assert.equal(refused.failure.details?.surfaceHostExecutable, surfaceHostExecutables[0]);
    }
    assert.deepEqual(fixture.surfaceHostChecks, [
      undefined,
      { executables: surfaceHostExecutables, simulatorUdid: target.simulator.udid },
    ]);
  } finally {
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent source close callers await the same detached preparation cleanup', async () => {
  const root = await mkdtempForTest('agent-device-snapshot-adapter-close-');
  const sourceRoot = path.join(root, 'source');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  for (const file of SNAPSHOT_BRIDGE_SOURCE_FILENAMES)
    await writeFile(path.join(sourceRoot, file), 'fixture source');
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = createAdapterHost();
  const source = createSimulatorSnapshotSource({
    sourceRoot,
    cacheRoot: path.join(root, 'cache'),
    host: {
      ...fixture.host,
      run: async (command, args, options) => {
        if (command === 'xcrun' && args.includes('clang')) {
          entered();
          await releasePromise;
        }
        return await fixture.host.run(command, args, options);
      },
    },
  });
  const acquiring = source.acquire({
    target: { ...targetForTest(), generation: 'generation-1' },
    hint: deriveIosCaptureHint(createIosSnapshotRequest()),
  });
  await enteredPromise;
  const first = source.close();
  let secondFinished = false;
  const second = source.close().then(() => {
    secondFinished = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(secondFinished, false, 'close resolved before the owned build settled');
  } finally {
    release();
    await Promise.all([first, second, acquiring]);
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(secondFinished, true);
  assert.equal(fixture.startedTargets.length, 0);
});

test('a capture reports a cold preparation instead of spending its deadline on it', async () => {
  const root = await mkdtempForTest('agent-device-snapshot-adapter-preparing-');
  const sourceRoot = path.join(root, 'source');
  const cacheRoot = path.join(root, 'cache');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  for (const name of SNAPSHOT_BRIDGE_SOURCE_FILENAMES) {
    await writeFile(path.join(sourceRoot, name), 'native source');
  }
  const fixture = createAdapterHost(300);
  const source = createSimulatorSnapshotSource({ host: fixture.host, sourceRoot, cacheRoot });
  const hint = deriveIosCaptureHint(createIosSnapshotRequest());
  const target = { ...targetForTest(), generation: 'generation-1' };

  try {
    const startedAt = performance.now();
    let outcome: SnapshotSourceOutcome = await source.acquire({
      target,
      hint,
      limits: { maxDurationMs: 100 },
    });
    const waitedMs = performance.now() - startedAt;
    assert.equal(outcome.stage, 'failed');
    if (outcome.stage === 'failed') {
      assert.equal(outcome.failure.kind, 'preparing');
      assert.equal(outcome.failure.code, 'bridge-preparation-pending');
    }
    // The capture ends on its own budget while the attempt it started keeps compiling detached;
    // waiting for that build is what let a cold host cancel captures that had a working runner.
    assert.ok(waitedMs < 300, `capture waited ${waitedMs}ms for a 300ms build`);

    for (let attempt = 0; attempt < 20 && outcome.stage !== 'acquired'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      outcome = await source.acquire({ target, hint });
    }
    assert.equal(outcome.stage, 'acquired');
    assert.equal(fixture.builds, 1);
  } finally {
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('binary preparation and helper connection share the source readiness allowance', async () => {
  const root = await mkdtempForTest('agent-device-snapshot-adapter-readiness-');
  const sourceRoot = path.join(root, 'source');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  for (const name of SNAPSHOT_BRIDGE_SOURCE_FILENAMES) {
    await writeFile(path.join(sourceRoot, name), 'native source');
  }
  const fixture = createAdapterHost(1500);
  let buildEntered!: () => void;
  const building = new Promise<void>((resolve) => {
    buildEntered = resolve;
  });
  let connectEntered!: () => void;
  const connecting = new Promise<void>((resolve) => {
    connectEntered = resolve;
  });
  let connections = 0;
  const source = createSimulatorSnapshotSource({
    sourceRoot,
    cacheRoot: path.join(root, 'cache'),
    host: {
      ...fixture.host,
      run: async (command, args, options) => {
        const work = fixture.host.run(command, args, options);
        if (command === 'xcrun' && args.includes('clang')) buildEntered();
        return await work;
      },
      connect: async (...args) => {
        connections += 1;
        const delay = new Promise((resolve) => setTimeout(resolve, 1000));
        connectEntered();
        await delay;
        return await fixture.host.connect(...args);
      },
    },
  });
  const request = {
    target: { ...targetForTest(), generation: 'generation-1' },
    hint: deriveIosCaptureHint(createIosSnapshotRequest()),
  };
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  try {
    const startedAt = Date.now();
    let finished = false;
    const acquiring = source.acquire(request).then((outcome) => {
      finished = true;
      return outcome;
    });
    await building;
    await vi.advanceTimersByTimeAsync(1500);
    await connecting;
    await vi.advanceTimersByTimeAsync(499);
    assert.equal(finished, false);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(finished, true, 'helper startup received a second readiness allowance');
    const pending = await acquiring;
    assert.equal(pending.stage, 'failed');
    assert.equal(pending.failure.kind, 'preparing');
    assert.equal(pending.failure.code, 'bridge-readiness-pending');
    assert.equal(Date.now() - startedAt, 2000);
    assert.equal(fixture.requestedDepths.length, 0, 'pending startup dispatched no capture');

    await vi.advanceTimersByTimeAsync(500);
    assert.equal((await source.acquire(request)).stage, 'acquired');
    assert.equal((await source.acquire(request)).stage, 'acquired');
    assert.equal(fixture.builds, 1);
    assert.equal(fixture.startedTargets.length, 1);
    assert.equal(connections, 1);
    assert.equal(fixture.requestedDepths.length, 2);
  } finally {
    const closing = source.close();
    await vi.advanceTimersByTimeAsync(1000);
    await closing;
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});

test('the Simulator AX source learns a hint only from a validated acquisition', async () => {
  const root = await mkdtempForTest('agent-device-snapshot-adapter-hints-');
  const sourceRoot = path.join(root, 'source');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  for (const name of SNAPSHOT_BRIDGE_SOURCE_FILENAMES) {
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

test('the Simulator AX source forgets a hint once a default-depth probe-back is accepted', async () => {
  const root = await mkdtempForTest('agent-device-snapshot-adapter-forget-');
  const sourceRoot = path.join(root, 'source');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  for (const name of SNAPSHOT_BRIDGE_SOURCE_FILENAMES) {
    await writeFile(path.join(sourceRoot, name), 'native source');
  }
  const fixture = createAdapterHost();
  // Default limits: the traversal bound is deeper than one native request.
  const source = createSimulatorSnapshotSource({
    host: fixture.host,
    sourceRoot,
    cacheRoot: path.join(root, 'cache'),
  });
  const hint = deriveIosCaptureHint(createIosSnapshotRequest());
  const target = { ...targetForTest(), targetId: 'target-1', generation: 'generation-1' };

  try {
    fixture.rejectLevelsAbove = 32;
    assert.equal((await source.acquire({ target, hint })).stage, 'acquired');
    fixture.rejectLevelsAbove = undefined;
    for (let use = 0; use <= DEPTH_HINT_PROBE_BACK_AFTER_USES; use++) {
      assert.equal((await source.acquire({ target, hint })).stage, 'acquired');
    }
    assert.equal((await source.acquire({ target, hint })).stage, 'acquired');
    assert.deepEqual(
      fixture.diagnostics
        .slice(-2)
        .map((event) => [event.requestedLevels, event.hint, event.learning]),
      [
        [129, 'probe-back', 'forgotten'],
        [129, 'no-hint', 'ignored'],
      ],
    );
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
  const root = await mkdtempForTest('agent-device-snapshot-adapter-contract-');
  const sourceRoot = path.join(root, 'source');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  for (const name of SNAPSHOT_BRIDGE_SOURCE_FILENAMES) {
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

test('the Simulator AX source refuses a window whose coordinate space it cannot resolve', async () => {
  const root = await mkdtempForTest('agent-device-snapshot-adapter-');
  const sourceRoot = path.join(root, 'source');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  for (const name of SNAPSHOT_BRIDGE_SOURCE_FILENAMES) {
    await writeFile(path.join(sourceRoot, name), 'native source');
  }
  const fixture = createAdapterHost();
  fixture.turnedWindow = true;
  const source = createSimulatorSnapshotSource({
    host: fixture.host,
    sourceRoot,
    cacheRoot: path.join(root, 'cache'),
  });
  const target = { ...targetForTest(), generation: 'generation-1', targetId: 'target-1' };

  try {
    const outcome = await source.acquire({
      target,
      hint: deriveIosCaptureHint(createIosSnapshotRequest()),
    });
    assert.equal(outcome.stage, 'failed');
    if (outcome.stage === 'failed') {
      assert.equal(outcome.failure.kind, 'unsupported');
      assert.equal(outcome.failure.code, 'window-coordinate-space-unresolved');
      assert.equal(outcome.failure.details?.windows, 1);
    }

    // The screen, not the app generation, is what the refusal is about: the same generation is served
    // by the bridge again once no surface reports in another space.
    fixture.turnedWindow = false;
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

test('the Simulator AX source publishes absence only from a complete tree with no keyboard trace', async () => {
  const root = await mkdtempForTest('agent-device-snapshot-adapter-keyboard-');
  const sourceRoot = path.join(root, 'source');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  for (const name of SNAPSHOT_BRIDGE_SOURCE_FILENAMES) {
    await writeFile(path.join(sourceRoot, name), 'native source');
  }
  const fixture = createAdapterHost();
  const source = createSimulatorSnapshotSource({
    host: fixture.host,
    sourceRoot,
    cacheRoot: path.join(root, 'cache'),
  });
  const target = { ...targetForTest(), generation: 'generation-1', targetId: 'target-1' };

  try {
    for (const entry of ADAPTER_KEYBOARD_CASES) {
      fixture.windows = entry.windows;
      fixture.truncated = entry.truncated;
      for (const acquisitionIntent of ['full', 'surface-observation'] as const) {
        const outcome = await source.acquire({
          target,
          hint: deriveIosCaptureHint(createIosSnapshotRequest({ acquisitionIntent })),
        });
        assert.equal(outcome.stage, 'acquired', `${entry.name} (${acquisitionIntent})`);
        if (outcome.stage !== 'acquired') continue;
        assert.equal(outcome.acquisition.truncated, entry.truncated);
        assert.deepEqual(
          outcome.acquisition.keyboard,
          entry.keyboard,
          `${entry.name} (${acquisitionIntent})`,
        );
      }
    }
  } finally {
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});
