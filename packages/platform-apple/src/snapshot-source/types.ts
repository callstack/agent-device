import type { ExecResult } from '@agent-device/host-kit/command';
import type { CaptureHint, IosViewportEvidence } from '@agent-device/contracts/ios-snapshot';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { NativeBuildHost } from '../native-build/host.ts';
import type { SimulatorAddress } from '../core/simctl.ts';

export type SnapshotSourceLimits = Readonly<{
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxNodes: number;
  maxTraversalDepth: number;
  maxDurationMs: number;
}>;

/** The app generation a bridge read is planned against, whichever process reads the tree. */
export type SnapshotBridgeTarget = Readonly<{
  pid: number;
  generation: string;
  targetId?: string;
  processStartTime?: string;
}>;

/** A target the host reaches through its own guest bridge process on a local Simulator. */
export type SnapshotSourceTarget = SnapshotBridgeTarget &
  Readonly<{
    simulator: SimulatorAddress;
    runtime: string;
  }>;

export type SnapshotBridgeSourceRequest<Target extends SnapshotBridgeTarget> = Readonly<{
  target: Target;
  hint: CaptureHint;
  /**
   * System surface host executables whose running process refuses this capture with
   * `system-surface-host-present`. Absent means the caller already knows no host presents. The
   * guest accepts 1 to 8 names of 1 to 256 characters each.
   */
  surfaceHostExecutables?: readonly string[];
  limits?: Partial<SnapshotSourceLimits>;
  signal?: AbortSignal;
}>;

export type SnapshotSourceRequest = SnapshotBridgeSourceRequest<SnapshotSourceTarget>;

export type {
  SnapshotSourceFailure,
  SnapshotSourceFailureKind,
  SnapshotSourceOutcome,
} from '@agent-device/capture-kit/snapshot-source-channel';

export type SnapshotSourceProcess = Readonly<{
  pid: number;
  wait: Promise<ExecResult>;
  isAlive(): boolean;
  signal(signal: NodeJS.Signals): void;
  readLog(): string;
}>;

export type SnapshotSourceSocket = Readonly<{
  destroyed: boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  write(data: Buffer): boolean;
  destroy(error?: Error): void;
}>;

/**
 * The shared native-build host (file access, exec, lock, process identity) plus what a bridge
 * session needs beyond a build: socket start/connect, diagnostics, and target inspection (#2970).
 */
export type SnapshotSourceHost = NativeBuildHost &
  Readonly<{
    projectRoot(): string;
    homeDirectory(): string;
    start(
      simulator: SimulatorAddress,
      bridgePath: string,
      socketPath: string,
      options?: { signal?: AbortSignal },
    ): SnapshotSourceProcess;
    connect(
      socketPath: string,
      options: { signal?: AbortSignal; timeoutMs: number },
    ): Promise<SnapshotSourceSocket>;
    emitDiagnostic(event: {
      level?: 'debug' | 'info' | 'warn' | 'error';
      phase: string;
      durationMs?: number;
      data?: Record<string, unknown>;
    }): void;
    withDiagnosticTimer<T>(
      phase: string,
      action: () => Promise<T> | T,
      data?: Record<string, unknown>,
    ): Promise<T>;
    readTargetProcessStartTime(
      pid: number,
      options: { signal?: AbortSignal; timeoutMs: number },
    ): Promise<string | null>;
  }>;

export type SnapshotSourceBridgeBinary = Readonly<{
  path: string;
  sourceHash: string;
  cacheKey: string;
  protocolVersion: number;
  sourceVersion: string;
}>;

export type SnapshotSourceDecodedTree = Readonly<{
  nodes: readonly RawSnapshotNode[];
  viewport: IosViewportEvidence;
  maxTraversalDepth: number;
  /**
   * `AXRemoteElement` leaves under a web view or a scene-hosting view whose frame reaches the
   * viewport, or that report no frame: pages and extensions the reader could not cross into (#2484).
   */
  opaqueRemoteElements: number;
  /**
   * Windows whose own box is the app's box quarter-turned: their subtree reports in the device's
   * native space and this producer cannot name the app's interface orientation to turn it back
   * (#2612).
   */
  unresolvedCoordinateSpaceWindows: number;
}>;
