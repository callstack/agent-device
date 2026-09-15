import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTest } from '../__tests__/tmp-dir.ts';
import { createSnapshotSourceDeadline, type SnapshotSourceDeadline } from './deadline.ts';
import { createSnapshotSourceHost } from './host.ts';
import { resolveSnapshotSourceLimits } from './limits.ts';
import {
  createSnapshotBridgePreparation,
  type SnapshotBridgePreparation,
  SNAPSHOT_BRIDGE_PREPARATION_RETRY_AFTER_MS,
} from './preparation.ts';
import type { SnapshotSourceBridgeBinary, SnapshotSourceHost } from './types.ts';

const BRIDGE_SOURCES = [
  'SnapshotBridge.m',
  'SnapshotBridgeRuntime.m',
  'SnapshotBridgeRuntime.h',
  'SnapshotBridgeCapture.h',
  'SnapshotBridgeCapture.m',
];

test('one detached preparation answers every capture that arrives while it runs', async () => {
  const root = await writeBridgeSource('preparation-shared-');
  let releaseBuild = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseBuild = resolve;
  });
  const fixture = createPreparationHost(async () => {
    await gate;
    return 'built';
  });
  const preparation = createSnapshotBridgePreparation({
    host: fixture.host,
    limits: resolveSnapshotSourceLimits({}),
    producer: 'test',
    sourceRoot: path.join(root, 'source'),
    cacheRoot: path.join(root, 'cache'),
  });

  try {
    const pending = await Promise.all([
      preparation.readyBinary('ios-simulator', deadline(300), 'test-deadline').then(
        () => undefined,
        (error: unknown) => failureOf(error),
      ),
      preparation.readyBinary('ios-simulator', deadline(300), 'test-deadline').then(
        () => undefined,
        (error: unknown) => failureOf(error),
      ),
    ]);
    for (const failure of pending) {
      assert.equal(failure?.kind, 'preparing');
      assert.equal(failure?.code, 'bridge-preparation-pending');
    }
    assert.equal(fixture.builds, 1);

    releaseBuild();
    // A capture that arrives after the budget is spent is pointed at the runner rather than made to
    // wait again, so this is a poll loop finding the finished bridge, not one waiting it out.
    const binary = await readyWithin(preparation, 2_000);
    assert.ok(binary.path.startsWith(path.join(root, 'cache')));
    assert.ok(binary.cacheKey.length > 0);
    assert.equal(fixture.builds, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed preparation is reported to each capture without rebuilding per capture', async () => {
  const root = await writeBridgeSource('preparation-failed-');
  let clockMs = 0;
  const fixture = createPreparationHost(async () => {
    // A cold host spends the retry window building before it fails at all, which is what the
    // window has to be measured against (#2491).
    clockMs += SNAPSHOT_BRIDGE_PREPARATION_RETRY_AFTER_MS + 1_000;
    return 'failed';
  });
  const preparation = createSnapshotBridgePreparation({
    host: fixture.host,
    limits: resolveSnapshotSourceLimits({}),
    producer: 'test',
    sourceRoot: path.join(root, 'source'),
    cacheRoot: path.join(root, 'cache'),
    now: () => clockMs,
  });

  try {
    const first = await prepare(
      preparation,
      deadline(5_000, () => clockMs),
    );
    assert.equal(first?.kind, 'unsupported');
    assert.equal(first?.code, 'native-build-failed');
    assert.equal(fixture.builds, 1);

    // The attempt above is long past the window measured from its start; measured from the failure
    // it is brand new, and a tight wait-poll loop must not launch a compile every 200 ms.
    const again = await prepare(
      preparation,
      deadline(5_000, () => clockMs),
    );
    assert.deepEqual(again, first);
    assert.equal(fixture.builds, 1);

    clockMs += SNAPSHOT_BRIDGE_PREPARATION_RETRY_AFTER_MS + 1;
    const retried = await prepare(
      preparation,
      deadline(5_000, () => clockMs),
    );
    assert.equal(retried?.code, 'native-build-failed');
    assert.equal(fixture.builds, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('only the first capture waits out the budget for a cold preparation', async () => {
  const root = await writeBridgeSource('preparation-wait-');
  let releaseBuild = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseBuild = resolve;
  });
  const fixture = createPreparationHost(async () => {
    await gate;
    return 'built';
  });
  const preparation = createSnapshotBridgePreparation({
    host: fixture.host,
    limits: resolveSnapshotSourceLimits({}),
    producer: 'test',
    sourceRoot: path.join(root, 'source'),
    cacheRoot: path.join(root, 'cache'),
  });

  try {
    const paying = prepare(preparation, deadline(30_000));
    // The capture that arrives while the first is still waiting is the `wait` poll of a caller that
    // has already spent the budget: it is told to use the runner at once, in seconds it can spare.
    await delay(150);
    const joined = Date.now();
    const second = await prepare(preparation, deadline(30_000));
    assert.equal(second?.code, 'bridge-preparation-pending');
    assert.ok(
      Date.now() - joined < 500,
      `a capture that arrived while the first was waiting took ${Date.now() - joined}ms`,
    );
    assert.equal(fixture.builds, 1);

    releaseBuild();
    // The capture that paid the budget either caught the finished build or went to the runner with
    // `preparing`; either answer is fine, what the test pinned is that only one capture paid.
    await paying;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('closing the preparation stops a build that is still running', async () => {
  const root = await writeBridgeSource('preparation-close-');
  const fixture = createPreparationHost(({ signal, attempt }) => {
    if (attempt > 1) return Promise.resolve('built');
    // `run` rejects on abort the way the real host does, so the build's own cleanup runs.
    return new Promise<'built'>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });
  const preparation = createSnapshotBridgePreparation({
    host: fixture.host,
    limits: resolveSnapshotSourceLimits({}),
    producer: 'test',
    sourceRoot: path.join(root, 'source'),
    cacheRoot: path.join(root, 'cache'),
  });

  try {
    const pending = await prepare(preparation, deadline(300));
    assert.equal(pending?.code, 'bridge-preparation-pending');
    assert.equal(fixture.signals.at(-1)?.aborted, false);

    preparation.close();
    // Reaching the build is the point: no request owns this attempt any more, and a bridge write
    // landing after the source closed would belong to nobody.
    assert.equal(fixture.signals.at(-1)?.aborted, true);

    const next = await prepare(preparation, deadline(5_000));
    assert.equal(next, undefined);
    assert.equal(fixture.builds, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeBridgeSource(prefix: string): Promise<string> {
  const root = await mkdtempForTest(`agent-device-bridge-${prefix}`);
  const sourceRoot = path.join(root, 'source');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  for (const name of BRIDGE_SOURCES) {
    await writeFile(path.join(sourceRoot, name), 'native source');
  }
  return root;
}

function deadline(timeoutMs: number, now: () => number = Date.now): SnapshotSourceDeadline {
  return createSnapshotSourceDeadline(timeoutMs, undefined, now);
}

function prepare(
  preparation: SnapshotBridgePreparation,
  captureDeadline: SnapshotSourceDeadline,
): Promise<Readonly<{ kind: string; code: string }> | undefined> {
  return preparation.readyBinary('ios-simulator', captureDeadline, 'test-deadline').then(
    () => undefined,
    (error: unknown) => failureOf(error),
  );
}

/**
 * Reads the preparation the way a `wait` poll does: a capture that was pointed at the runner comes
 * back later, when the bridge may exist.
 */
async function readyWithin(
  preparation: SnapshotBridgePreparation,
  timeoutMs: number,
): Promise<SnapshotSourceBridgeBinary> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await preparation.readyBinary('ios-simulator', deadline(300), 'test-deadline');
    } catch (error) {
      if (Date.now() >= until || failureOf(error)?.code !== 'bridge-preparation-pending') {
        throw error;
      }
      await delay(20);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function failureOf(error: unknown): Readonly<{ kind: string; code: string }> | undefined {
  const failure = (error as Readonly<{ failureKind?: unknown; failureCode?: unknown }>) ?? {};
  return typeof failure.failureKind === 'string' && typeof failure.failureCode === 'string'
    ? { kind: failure.failureKind, code: failure.failureCode }
    : undefined;
}

function createPreparationHost(
  build: (
    context: Readonly<{ signal: AbortSignal | undefined; attempt: number }>,
  ) => Promise<'built' | 'failed'>,
): Readonly<{
  host: SnapshotSourceHost;
  builds: number;
  signals: (AbortSignal | undefined)[];
}> {
  const fixture: {
    host: SnapshotSourceHost;
    builds: number;
    signals: (AbortSignal | undefined)[];
  } = { host: undefined as never, builds: 0, signals: [] };
  const host: SnapshotSourceHost = {
    ...createSnapshotSourceHost(),
    run: async (command, args, options) => {
      if (command === 'xcrun' && args.includes('clang')) {
        fixture.builds += 1;
        fixture.signals.push(options?.signal);
        const outcome = await build({ signal: options?.signal, attempt: fixture.builds });
        if (outcome === 'failed') return { stdout: '', stderr: 'boom', exitCode: 1 };
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
  };
  fixture.host = host;
  return fixture;
}
