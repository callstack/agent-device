import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, vi } from 'vitest';
import { createSnapshotSourceHost } from './host.ts';
import { SnapshotSourceError } from '@agent-device/capture-kit/snapshot-source-channel';
import { snapshotSourceError } from './errors.ts';
import { createSnapshotSourceDeadline } from './deadline.ts';
import {
  encodeSnapshotBridgeFrame,
  SNAPSHOT_SOURCE_PROTOCOL_VERSION,
  SNAPSHOT_SOURCE_VERSION,
} from './protocol.ts';
import { simulatorAddressFor } from '../core/simctl.ts';
import { createLiveTestHostEnvironment } from '@agent-device/test-kit';
import type {
  SnapshotSourceHost,
  SnapshotSourceLimits,
  SnapshotSourceProcess,
  SnapshotSourceSocket,
  SnapshotSourceTarget,
} from './types.ts';

export const limits: SnapshotSourceLimits = {
  maxRequestBytes: 64 * 1024,
  maxResponseBytes: 4 * 1024,
  maxNodes: 20,
  maxTraversalDepth: 10,
  maxDurationMs: 100,
};

export const simulatorDevice = {
  platform: 'apple',
  id: 'simulator-1',
  name: 'iPhone 17',
  kind: 'simulator',
  target: 'mobile',
} as const;

export const target = {
  simulator: simulatorAddressFor(simulatorDevice),
  runtime: 'iOS 26.2',
  pid: 123,
  generation: 'generation-1',
};

export const bridge = {
  path: '/tmp/snapshot-bridge',
  sourceHash: 'source-hash',
  cacheKey: 'cache-key',
  protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
  sourceVersion: SNAPSHOT_SOURCE_VERSION,
};

export type LifecycleFixture = {
  host: SnapshotSourceHost;
  processes: FakeProcess[];
  sockets: FakeSocket[];
  diagnostics: Array<Parameters<SnapshotSourceHost['emitDiagnostic']>[0]>;
  socketPaths: string[];
  startedTargets: Array<Parameters<SnapshotSourceHost['start']>[0]>;
  /** The directory each bridge session setup asked the host to create, in order. */
  directorySetups: string[];
  /** The socket each bridge connect attempt was for, in order, including one that has not returned. */
  connects: string[];
};

/**
 * Runs each test in the file on fake timers that jump to the next timer whenever the loop idles.
 * The fake helper answers through timers, and the manager's budget waits are timers too, so timer
 * order alone decides each race: a loaded host cannot spend a 100 ms budget before a 0 ms reply.
 * A test that drives time itself installs fake timers again in manual mode.
 */
export function installTimerOrderedTime(): void {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setTimerTickMode('nextTimerAsync');
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

export function deadline(signal?: AbortSignal, timeoutMs = limits.maxDurationMs) {
  return createSnapshotSourceDeadline(timeoutMs, signal);
}

export async function waitForDispatch(fixture: LifecycleFixture): Promise<void> {
  await waitForFixture(
    () => fixture.sockets[0]?.writes === 1,
    'Fixture request was not dispatched',
  );
}

/** Whether `pending` finishes on its own inside `graceMs`, so a test can name a wait it must not need. */
export async function settleWithin(
  pending: Promise<void>,
  graceMs: number,
): Promise<'settled' | 'pending'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending.then(() => 'settled' as const),
      new Promise<'pending'>((resolve) => {
        timer = setTimeout(() => resolve('pending'), graceMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForFixture(condition: () => boolean, message: string): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt >= 1000) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

export function createPause(): Readonly<{ wait: () => Promise<void>; release: () => void }> {
  let release!: () => void;
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    wait: async () => {
      await resumed;
    },
    release,
  };
}

export function isClosedSourceFailure(error: unknown): boolean {
  return (
    error instanceof SnapshotSourceError &&
    error.failureKind === 'unsupported' &&
    error.failureCode === 'source-closed'
  );
}

export function isHelperCrashFailure(error: unknown): boolean {
  return (
    error instanceof SnapshotSourceError &&
    error.failureKind === 'process-crash' &&
    error.failureCode === 'bridge-exited'
  );
}

export function exitDiagnostics(fixture: LifecycleFixture): LifecycleFixture['diagnostics'] {
  return fixture.diagnostics.filter(
    (event) => event.phase === 'ios.snapshot-source.bridge-process-exit',
  );
}

export function createLifecycleFixture(
  options: {
    connectDelayMs?: number;
    responseDelayMs?: number;
    responsePid?: number;
    responseGeneration?: string;
    responseErrorKind?: string;
    targetStartTimes?: Array<string | null>;
    /** Holds the bridge's directory setup open so a test can close the manager inside it. */
    pauseAtDirectorySetup?: () => Promise<void>;
    /** Holds a bridge connect open so a test can close the manager inside it. */
    pauseAtConnect?: () => Promise<void>;
    /**
     * Takes the helper away without an exit status as the bridge connect is attempted, so the connect
     * fails and the manager is left reading a status that never arrives.
     */
    helperGoneAtConnect?: boolean;
  } = {},
): LifecycleFixture {
  const processes: FakeProcess[] = [];
  const sockets: FakeSocket[] = [];
  const diagnostics: LifecycleFixture['diagnostics'] = [];
  const socketPaths: string[] = [];
  const startedTargets: LifecycleFixture['startedTargets'] = [];
  const directorySetups: string[] = [];
  const connects: string[] = [];
  const realHost = createSnapshotSourceHost(createLiveTestHostEnvironment());
  const host: SnapshotSourceHost = {
    ...realHost,
    emitDiagnostic: (event) => diagnostics.push(event),
    // In memory, like every other fake here: the tests run on fake timers that advance whenever the
    // loop idles, so a real filesystem call would let a budget timer fire before it returned.
    ensureDirectory: async (directoryPath) => {
      directorySetups.push(directoryPath);
      if (options.pauseAtDirectorySetup) await options.pauseAtDirectorySetup();
    },
    remove: async () => {},
    readTargetProcessStartTime: async () => {
      const startTime = options.targetStartTimes?.shift();
      return startTime === undefined ? 'target-start' : startTime;
    },
    start: (startedTarget, _bridgePath, socketPath) => {
      startedTargets.push(startedTarget);
      socketPaths.push(socketPath);
      const process = new FakeProcess(700 + processes.length);
      processes.push(process);
      return process;
    },
    connect: async (socketPath, connectOptions) => {
      connects.push(socketPath);
      if (options.pauseAtConnect) await options.pauseAtConnect();
      if (options.helperGoneAtConnect) {
        // The manager already saw the helper start, so this is a launch that died without ever
        // reporting its status: the socket it would have answered on is gone with it.
        processes[0]?.exitWithoutStatus();
        throw snapshotSourceError('transport-failure', 'bridge-closed-before-connect');
      }
      if (options.connectDelayMs) {
        await new Promise<void>((resolve, reject) => {
          const finish = (error?: SnapshotSourceError) => {
            clearTimeout(timer);
            connectOptions.signal?.removeEventListener('abort', onAbort);
            if (error) reject(error);
            else resolve();
          };
          const timer = setTimeout(() => finish(), options.connectDelayMs);
          const onAbort = () => {
            finish(snapshotSourceError('cancelled', 'abort-signal'));
          };
          connectOptions.signal?.addEventListener('abort', onAbort, { once: true });
          if (connectOptions.signal?.aborted) onAbort();
        });
      }
      const socket = new FakeSocket(
        options.responseDelayMs ?? 0,
        options.responsePid ?? target.pid,
        options.responseGeneration,
        options.responseErrorKind,
      );
      sockets.push(socket);
      return socket;
    },
  };
  return {
    host,
    processes,
    sockets,
    diagnostics,
    socketPaths,
    startedTargets,
    directorySetups,
    connects,
  };
}

class FakeProcess implements SnapshotSourceProcess {
  alive = true;
  signals: NodeJS.Signals[] = [];
  /** How often the manager asked for the exit status, counting one read still awaiting a result. */
  exitStatusReads = 0;
  private readonly processId: number;
  private readonly exitStatus: Promise<{ stdout: string; stderr: string; exitCode: number }>;
  private resolveExitStatus!: (result: {
    stdout: string;
    stderr: string;
    exitCode: number;
  }) => void;
  private rejectExitStatus!: (error: Error) => void;

  constructor(pid: number) {
    this.processId = pid;
    this.exitStatus = new Promise((resolve, reject) => {
      this.resolveExitStatus = resolve;
      this.rejectExitStatus = reject;
    });
  }

  get pid(): number {
    return this.processId;
  }

  get wait(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.exitStatusReads += 1;
    return this.exitStatus;
  }

  isAlive(): boolean {
    return this.alive;
  }

  signal(signal: NodeJS.Signals): void {
    this.signals.push(signal);
    this.alive = false;
    this.resolveExitStatus({ stdout: '', stderr: '', exitCode: signal === 'SIGKILL' ? 137 : 0 });
  }

  crash(): void {
    this.alive = false;
    this.resolveExitStatus({ stdout: '', stderr: 'crashed', exitCode: 1 });
  }

  /** Goes away without ever reporting its status, the way a helper with inherited pipes can. */
  exitWithoutStatus(): void {
    this.alive = false;
  }

  /** Goes away with the status read itself failing, the way a launch that never started can. */
  exitWithFailedStatus(): void {
    this.alive = false;
    this.rejectExitStatus(new Error('helper launch failed'));
  }

  readLog(): string {
    return 'fixture log';
  }
}

class FakeSocket extends EventEmitter implements SnapshotSourceSocket {
  destroyed = false;
  writes = 0;
  private readonly responseDelayMs: number;
  private readonly responsePid: number;
  private readonly responseGeneration: string | undefined;
  private readonly responseErrorKind: string | undefined;

  constructor(
    responseDelayMs: number,
    responsePid: number,
    responseGeneration: string | undefined,
    responseErrorKind?: string,
  ) {
    super();
    this.responseDelayMs = responseDelayMs;
    this.responsePid = responsePid;
    this.responseGeneration = responseGeneration;
    this.responseErrorKind = responseErrorKind;
  }

  write(frame: Buffer): boolean {
    this.writes += 1;
    const bodyLength = frame.readUInt32BE(0);
    const request = JSON.parse(frame.subarray(4, bodyLength + 4).toString('utf8')) as {
      requestId: string;
      pid: number;
      generation: string;
    };
    setTimeout(() => {
      if (this.destroyed) return;
      this.emit(
        'data',
        encodeSnapshotBridgeFrame(
          this.responseErrorKind
            ? {
                protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
                sourceVersion: SNAPSHOT_SOURCE_VERSION,
                requestId: request.requestId,
                ok: false,
                pid: this.responsePid ?? request.pid,
                generation: this.responseGeneration ?? request.generation,
                error_kind: this.responseErrorKind,
                error_code: 'fixture-error',
              }
            : {
                protocolVersion: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
                sourceVersion: SNAPSHOT_SOURCE_VERSION,
                requestId: request.requestId,
                ok: true,
                pid: this.responsePid ?? request.pid,
                generation: this.responseGeneration ?? request.generation,
                truncated: false,
                automationEnabled: true,
                tree: {
                  XC_kAXXCAttributeElementType: 'Application',
                  XC_kAXXCAttributeChildren: [],
                },
              },
          limits,
        ),
      );
    }, this.responseDelayMs);
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
  }
}

function compileTimeSnapshotTargetProof(): SnapshotSourceTarget {
  // @ts-expect-error A target names its simulator through an address minted from its DeviceInfo.
  return { udid: 'simulator-1', runtime: 'iOS 26.2', pid: 123, generation: 'generation-1' };
}
void compileTimeSnapshotTargetProof;
