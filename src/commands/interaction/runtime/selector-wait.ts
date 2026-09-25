import { AppError } from '@agent-device/kernel/errors';
import { findNodeByRef, normalizeRef, type SnapshotNode } from '@agent-device/kernel/snapshot';
import type { TargetAnnotationV1 } from '@agent-device/contracts/replay';
import type { PublicPlatform } from '@agent-device/kernel/device';
import type { CapturedSnapshot } from './selector-read-shared.ts';
import { checkWaitText, STALE_REF_HINT } from '@agent-device/selectors';
import { INTERACTION_ERROR_REASONS } from '@agent-device/selectors/interaction-error';
import { resolveRefLabel } from './selector-read-utils.ts';
import { sleepWithWaitCancellation } from './wait-polling.ts';
import { waitForAbsent } from './wait-absent.ts';
import { waitForSelector } from './wait-selector.ts';
import { waitForStable } from './wait-stable.ts';
import { waitForText } from './wait-text.ts';

export type WaitCommandContext = {
  session?: string;
  requestId?: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
};

export type SelectorSnapshotOptions = {
  depth?: number;
  scope?: string;
  raw?: boolean;
};

export type WaitCommandOptions = WaitCommandContext &
  SelectorSnapshotOptions & {
    target:
      | { kind: 'sleep'; durationMs: number }
      | { kind: 'text'; text: string; timeoutMs?: number | null }
      | { kind: 'ref'; ref: string; timeoutMs?: number | null }
      | {
          kind: 'selector';
          selector: string;
          timeoutMs?: number | null;
          /**
           * ADR 0012 / #1349, replay-only: the recorded landmark identity this
           * wait must observe before reporting success. Polling is unchanged —
           * the loop keeps waiting while no selector match carries this
           * identity, and a timeout with rejected candidates throws the
           * `WAIT_LANDMARK_MISMATCH_REASON` refusal instead of success.
           */
          recordedLandmark?: TargetAnnotationV1;
        }
      | { kind: 'absent'; selector: string; timeoutMs?: number | null }
      | { kind: 'stable'; quietMs?: number | null; timeoutMs?: number | null };
  };

export type WaitCommandResult =
  | { kind: 'sleep'; waitedMs: number }
  | { kind: 'text'; waitedMs: number; text: string }
  | {
      kind: 'selector';
      waitedMs: number;
      selector: string;
      /** ADR 0012 decision 3: the satisfying match and the tree it came from, for record-time evidence. */
      node?: SnapshotNode;
      preActionNodes?: SnapshotNode[];
    }
  | { kind: 'absent'; waitedMs: number }
  | {
      kind: 'stable';
      waitedMs: number;
      captures: number;
      nodeCount: number;
      hint?: string;
    };

export type WaitForTextCommandOptions = WaitCommandContext &
  SelectorSnapshotOptions & {
    text: string;
    timeoutMs?: number | null;
  };

export type SelectorWaitRuntime = {
  backend: {
    platform: PublicPlatform;
    /**
     * The backend's native text reading, present only when the bound runtime advertised the
     * conditional `findText` operation. It is consulted first and is authoritative ONLY when it
     * answers `true`; see `waitForText`.
     */
    findText?: (context: WaitCommandContext, text: string) => Promise<{ found: boolean }>;
  };
  clock?: {
    now(): number;
    sleep(ms: number): Promise<void>;
  };
  signal?: AbortSignal;
};

type StableCaptureResult = {
  settled: boolean;
  stalled: boolean;
  waitedMs: number;
  captures: number;
  nodeCount: number;
};

export type SelectorWaitOperations<Runtime extends SelectorWaitRuntime> = {
  captureSnapshot: (
    runtime: Runtime,
    options: WaitCommandContext & SelectorSnapshotOptions,
    captureOptions: {
      updateSession: boolean;
      scope?: string;
      includeRects?: boolean;
      interactiveOnly?: boolean;
      includeHiddenContentHints?: boolean;
    },
  ) => Promise<CapturedSnapshot>;
  requireSnapshot: (
    runtime: Runtime,
    requestedName: string | undefined,
  ) => Promise<{ snapshot: { nodes: SnapshotNode[] } }>;
  stable: {
    defaultQuietMs: number;
    tinyTreeHint: string;
    tinyTreeNodeCount: number;
    capture: (
      runtime: Runtime,
      options: WaitCommandContext & SelectorSnapshotOptions,
      params: { quietMs: number; timeoutMs: number },
    ) => Promise<StableCaptureResult>;
  };
};

export function createSelectorWaitCommands<Runtime extends SelectorWaitRuntime>(
  operations: SelectorWaitOperations<Runtime>,
): {
  waitCommand: (runtime: Runtime, options: WaitCommandOptions) => Promise<WaitCommandResult>;
  waitForTextCommand: (
    runtime: Runtime,
    options: WaitForTextCommandOptions,
  ) => Promise<Extract<WaitCommandResult, { kind: 'text' }>>;
} {
  const waitCommand = async (
    runtime: Runtime,
    options: WaitCommandOptions,
  ): Promise<WaitCommandResult> => {
    switch (options.target.kind) {
      case 'sleep':
        await sleepWithWaitCancellation(runtime, options, options.target.durationMs);
        return { kind: 'sleep', waitedMs: options.target.durationMs };
      case 'ref':
        return await waitForRef(
          operations,
          runtime,
          options,
          options.target.ref,
          options.target.timeoutMs,
        );
      case 'selector':
        return await waitForSelector(
          operations,
          runtime,
          options,
          options.target.selector,
          options.target.timeoutMs,
          options.target.recordedLandmark,
        );
      case 'absent':
        return await waitForAbsent(
          operations,
          runtime,
          options,
          options.target.selector,
          options.target.timeoutMs,
        );
      case 'stable':
        return await waitForStable(
          operations,
          runtime,
          options,
          options.target.quietMs,
          options.target.timeoutMs,
        );
      case 'text':
        return await waitForTextTarget(
          operations,
          runtime,
          options,
          options.target.text,
          options.target.timeoutMs,
        );
      default:
        return assertNever(options.target);
    }
  };

  const waitForTextCommand = async (
    runtime: Runtime,
    options: WaitForTextCommandOptions,
  ): Promise<Extract<WaitCommandResult, { kind: 'text' }>> => {
    const result = await waitCommand(runtime, {
      ...options,
      target: { kind: 'text', text: options.text, timeoutMs: options.timeoutMs },
    });
    if (result.kind !== 'text') {
      throw new AppError('COMMAND_FAILED', 'waitForText returned non-text result');
    }
    return result;
  };

  return { waitCommand, waitForTextCommand };
}

async function waitForRef<Runtime extends SelectorWaitRuntime>(
  operations: SelectorWaitOperations<Runtime>,
  runtime: Runtime,
  options: WaitCommandOptions,
  rawRef: string,
  timeoutMs: number | null | undefined,
): Promise<Extract<WaitCommandResult, { kind: 'text' }>> {
  const capture = await operations.requireSnapshot(runtime, options.session);
  const ref = normalizeRef(rawRef);
  if (!ref) throw new AppError('INVALID_ARGS', `Invalid ref: ${rawRef}`);
  const node = findNodeByRef(capture.snapshot.nodes, ref);
  if (!node) {
    throw new AppError('COMMAND_FAILED', `Ref ${rawRef} not found`, {
      reason: INTERACTION_ERROR_REASONS.refNotFound,
      ref,
      hint: STALE_REF_HINT,
    });
  }
  const text = resolveRefLabel(node, capture.snapshot.nodes);
  if (!text) {
    throw new AppError('COMMAND_FAILED', `Ref ${rawRef} has no label to wait for`, {
      reason: INTERACTION_ERROR_REASONS.refUnlabeled,
      ref,
    });
  }
  return await waitForText(operations, runtime, options, text, timeoutMs);
}

async function waitForTextTarget<Runtime extends SelectorWaitRuntime>(
  operations: SelectorWaitOperations<Runtime>,
  runtime: Runtime,
  options: WaitCommandOptions,
  text: string,
  timeoutMs: number | null | undefined,
): Promise<Extract<WaitCommandResult, { kind: 'text' }>> {
  const waitText = checkWaitText(text);
  if (!waitText.ok) throw new AppError(waitText.code, waitText.message);
  return await waitForText(operations, runtime, options, waitText.text, timeoutMs);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported wait target: ${String(value)}`);
}
