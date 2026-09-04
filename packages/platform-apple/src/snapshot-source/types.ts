import type { ExecOptions, ExecResult } from '@agent-device/host-kit/command';
import type {
  CaptureHint,
  IosSnapshotAcquisition,
  IosViewportEvidence,
} from '@agent-device/contracts/ios-snapshot';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { SnapshotSourceDeadline } from './deadline.ts';

export type SnapshotSourceLimits = Readonly<{
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxNodes: number;
  maxTraversalDepth: number;
  maxDurationMs: number;
}>;

export type SnapshotSourceTarget = Readonly<{
  udid: string;
  runtime: string;
  pid: number;
  generation: string;
  targetId?: string;
}>;

export type SnapshotSourceRequest = Readonly<{
  target: SnapshotSourceTarget;
  hint: CaptureHint;
  limits?: Partial<SnapshotSourceLimits>;
  signal?: AbortSignal;
}>;

export type SnapshotSourceSuccess = Readonly<{
  stage: 'acquired';
  acquisition: IosSnapshotAcquisition;
}>;

export type SnapshotSourceFailureKind =
  | 'unsupported'
  | 'malformed-tree'
  | 'stale-target'
  | 'timeout'
  | 'cancelled'
  | 'process-crash'
  | 'transport-failure';

export type SnapshotSourceFailure = Readonly<{
  kind: SnapshotSourceFailureKind;
  code: string;
  details?: Readonly<Record<string, unknown>>;
}>;

export type SnapshotSourceOutcome =
  | SnapshotSourceSuccess
  | Readonly<{
      stage: 'failed';
      failure: SnapshotSourceFailure;
    }>;

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

export type SnapshotSourceHost = Readonly<{
  projectRoot(): string;
  homeDirectory(): string;
  run(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  start(
    udid: string,
    bridgePath: string,
    socketPath: string,
    options?: { signal?: AbortSignal },
  ): SnapshotSourceProcess;
  connect(
    socketPath: string,
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<SnapshotSourceSocket>;
  readText(path: string): Promise<string>;
  readBinary(path: string): Promise<Buffer>;
  writeText(path: string, contents: string): Promise<void>;
  ensureDirectory(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  exists(path: string): boolean;
  rename(sourcePath: string, destinationPath: string): Promise<void>;
  remove(path: string): Promise<void>;
  acquireLock(
    path: string,
    options: { deadline: SnapshotSourceDeadline },
  ): Promise<() => Promise<void>>;
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
  processId(): number;
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
}>;
