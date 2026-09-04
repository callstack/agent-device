import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
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

    const prepared = await source.prepare({ runtime: 'iOS 26.2' });
    assert.equal(prepared.path.length > 0, true);
    assert.equal(fixture.builds, 1);

    fixture.responsePid = 999;
    const outcome = await source.acquireOutcome({
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
  } finally {
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});

type AdapterFixture = {
  host: SnapshotSourceHost;
  builds: number;
  responsePid: number;
};

function createAdapterHost(): AdapterFixture {
  const realHost = createSnapshotSourceHost();
  const fixture: AdapterFixture = { host: undefined as never, builds: 0, responsePid: 321 };
  const host: SnapshotSourceHost = {
    ...realHost,
    run: async (command, args) => {
      if (command === 'xcrun' && args.includes('clang')) {
        fixture.builds += 1;
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
