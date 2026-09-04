import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
  const fixture = createAdapterHost();
  const source = createSimulatorSnapshotSource({
    host: fixture.host,
    sourceRoot,
    cacheRoot,
    limits: { maxNodes: 20, maxTraversalDepth: 10, maxDurationMs: 1000 },
  });
  const request = createIosSnapshotRequest({ interactiveOnly: true });
  const hint = deriveIosCaptureHint(request);

  try {
    const result = await source.acquire({
      target: {
        udid: 'simulator-1',
        runtime: 'iOS 26.2',
        pid: 321,
        generation: 'generation-1',
        targetId: 'target-1',
      },
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

    fixture.responsePid = 999;
    const outcome = await source.acquire({
      target: {
        udid: 'simulator-1',
        runtime: 'iOS 26.2',
        pid: 321,
        generation: 'generation-1',
      },
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

test('preparation consumes the same acquisition deadline as bridge I/O', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-device-snapshot-adapter-deadline-'));
  const sourceRoot = path.join(root, 'source');
  const cacheRoot = path.join(root, 'cache');
  await (await import('@agent-device/host-kit/host-file')).ensureHostDirectory(sourceRoot);
  await writeFile(path.join(sourceRoot, 'SnapshotBridge.m'), 'native source');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeRuntime.m'), 'native runtime');
  await writeFile(path.join(sourceRoot, 'SnapshotBridgeRuntime.h'), 'native header');
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

type AdapterFixture = {
  host: SnapshotSourceHost;
  builds: number;
  runs: number;
  responsePid: number;
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
  };
  const host: SnapshotSourceHost = {
    ...realHost,
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
    connect: async () => new AdapterSocket(() => fixture.responsePid),
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
  private readonly readResponsePid: () => number;

  constructor(responsePid: () => number) {
    super();
    this.readResponsePid = responsePid;
  }

  write(frame: Buffer): boolean {
    const bodyLength = frame.readUInt32BE(0);
    const request = JSON.parse(frame.subarray(4, bodyLength + 4).toString('utf8')) as {
      requestId: string;
      pid: number;
      generation: string;
    };
    queueMicrotask(() => {
      if (this.destroyed) return;
      this.emit(
        'data',
        encodeSnapshotBridgeFrame(
          {
            protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
            sourceVersion: SNAPSHOT_SOURCE_VERSION,
            requestId: request.requestId,
            ok: true,
            pid: this.readResponsePid(),
            generation: request.generation,
            truncated: false,
            automationEnabled: true,
            tree: {
              XC_kAXXCAttributeElementType: 'Application',
              XC_kAXXCAttributeFrame: { X: 0, Y: 0, Width: 390, Height: 844 },
              XC_kAXXCAttributeChildren: [],
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
