import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createLiveTestHostEnvironment } from '@agent-device/test-kit';
import { simulatorAddressFor } from '../core/simctl.ts';
import { createSnapshotSourceHost } from './host.ts';
import { MAXIMUM_REQUEST_LEVELS } from './limits.ts';
import {
  encodeSnapshotBridgeFrame,
  SNAPSHOT_SOURCE_PROTOCOL_VERSION,
  SNAPSHOT_SOURCE_VERSION,
} from './protocol.ts';
import type { SnapshotSourceHost, SnapshotSourceProcess, SnapshotSourceSocket } from './types.ts';

export type AdapterFixture = {
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
  /** Whether the fake guest's tree holds a window reporting the app box quarter-turned (#2612). */
  turnedWindow: boolean;
  /** Whether the fake guest's root omits its frame, leaving the capture without a viewport. */
  omitViewport: boolean;
  /** Whether the fake guest finds a requested system surface host process running. */
  runningSurfaceHost: boolean;
  /** The surface host check each request carried: its executables and Simulator, or undefined. */
  surfaceHostChecks: Array<Readonly<{ executables: unknown; simulatorUdid: unknown }> | undefined>;
  /** The windows the fake guest reports under its root when no other tree shape is selected. */
  windows: readonly Record<string, unknown>[];
  omitRecovery: boolean;
  diagnostics: Record<string, unknown>[];
  startedTargets: Array<Parameters<SnapshotSourceHost['start']>[0]>;
};

export function targetForTest(simulatorSetPath?: string) {
  return {
    simulator: simulatorAddressFor({
      platform: 'apple',
      id: 'simulator-1',
      name: 'iPhone 17',
      kind: 'simulator',
      target: 'mobile',
      ...(simulatorSetPath ? { simulatorSetPath } : {}),
    }),
    runtime: 'iOS 26.2',
    pid: 321,
  };
}

export function createAdapterHost(buildDelayMs = 0): AdapterFixture {
  const realHost = createSnapshotSourceHost(createLiveTestHostEnvironment());
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
    turnedWindow: false,
    omitViewport: false,
    runningSurfaceHost: false,
    surfaceHostChecks: [],
    windows: [],
    omitRecovery: false,
    diagnostics: [],
    startedTargets: [],
  };
  const host: SnapshotSourceHost = {
    ...realHost,
    cpuArch: async () => 'arm64',
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
              : '26.2',
        stderr: '',
        exitCode: 0,
      };
    },
    start: (target) => {
      fixture.startedTargets.push(target);
      return new AdapterProcess();
    },
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

  /** The guest root's frame, or undefined when the fixture reports a viewportless tree. */
  private rootFrame(): Record<string, number> | undefined {
    return this.fixture.omitViewport ? undefined : { X: 0, Y: 0, Width: 390, Height: 844 };
  }

  write(frame: Buffer): boolean {
    const bodyLength = frame.readUInt32BE(0);
    const request = JSON.parse(frame.subarray(4, bodyLength + 4).toString('utf8')) as {
      requestId: string;
      pid: number;
      generation: string;
      maxDepth: number;
      nativeLevelsHint?: number;
      surfaceHostExecutables?: string[];
      simulatorUdid?: string;
    };
    this.fixture.surfaceHostChecks.push(
      request.surfaceHostExecutables
        ? { executables: request.surfaceHostExecutables, simulatorUdid: request.simulatorUdid }
        : undefined,
    );
    if (this.fixture.runningSurfaceHost && request.surfaceHostExecutables) {
      queueMicrotask(() =>
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
              error_kind: 'unsupported',
              error_code: 'system-surface-host-present',
              surfaceHostExecutable: request.surfaceHostExecutables![0],
            },
            { maxRequestBytes: 64 * 1024 },
          ),
        ),
      );
      return true;
    }
    this.fixture.requestedDepths.push(request.maxDepth);
    this.fixture.requestedHints.push(request.nativeLevelsHint);
    // The guest's own recovery: one request reads at most 65 levels, and a rejected depth halves
    // at most twice, like SnapshotBridgeCapture.
    const requestedLevels = Math.min(
      request.maxDepth + 1,
      request.nativeLevelsHint ?? MAXIMUM_REQUEST_LEVELS,
    );
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
                  XC_kAXXCAttributeFrame: this.rootFrame(),
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
                        : this.fixture.turnedWindow
                          ? [
                              {
                                XC_kAXXCAttributeElementType: 'Application',
                                XC_kAXXCAttributeElementBaseType: 'UIRemoteKeyboardWindow',
                                XC_kAXXCAttributeFrame: { X: 0, Y: 0, Width: 844, Height: 390 },
                                XC_kAXXCAttributeChildren: [
                                  {
                                    XC_kAXXCAttributeAutomationType: 20,
                                    XC_kAXXCAttributeLabel: 'q',
                                    XC_kAXXCAttributeFrame: {
                                      X: 154,
                                      Y: 77,
                                      Width: 45,
                                      Height: 72,
                                    },
                                    XC_kAXXCAttributeChildren: [],
                                  },
                                ],
                              },
                            ]
                          : this.fixture.windows,
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
