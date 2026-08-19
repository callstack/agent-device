import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Point } from '@agent-device/kernel/snapshot';
import type { RunnerContext } from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { SessionSurface } from './session-surface.ts';

/** Runner metadata the selected read implementation needs, without request-owned state. */
export type ElementTextRuntimeExecution = Readonly<Omit<RunnerContext, 'appBundleId' | 'signal'>>;

/**
 * Neutral intent for one point-addressed element read. The point is already resolved from the
 * node the caller matched, so the operation names no command, request, session, or CLI flag.
 */
export type ReadTextAtPointInput = Readonly<{
  point: Point;
  options?: Readonly<{ appBundleId?: string; surface?: SessionSurface }>;
  execution?: ElementTextRuntimeExecution;
}>;

/**
 * Why an owner that HAS a live read still produced no text for this point.
 *
 * Closed on purpose (ADR 0019 §2): a consumer may fall back to the required path only for a
 * reason named here. Anything else — a runner transport failure, a helper crash, a bug — is an
 * unexpected error and propagates, because silently answering from a stale captured tree after
 * an unclassified failure is exactly the "generic catch fallback" the ADR forbids.
 */
export type ElementTextUnreadableReason =
  /** The owner queried successfully and there is nothing readable at this point. */
  | 'no-text-at-point'
  /** The owner's read surface exists but declined this query (unsupported element/surface). */
  | 'surface-not-readable';

/** The closed outcome of one live element-text read. */
export type ElementTextReadOutcome =
  | Readonly<{ status: 'read'; text: string }>
  | Readonly<{ status: 'unreadable'; reason: ElementTextUnreadableReason }>;

/**
 * Normalizes a raw owner read into the closed outcome. Blank text is not a read: an owner that
 * answers with whitespace has told us there is nothing at this point, and saying so by reason
 * keeps every consumer off "did it fail or is it empty?" guesswork.
 */
export function elementTextRead(text: string | undefined | null): ElementTextReadOutcome {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return Object.freeze({ status: 'unreadable', reason: 'no-text-at-point' } as const);
  }
  return Object.freeze({ status: 'read', text } as const);
}

export type ElementTextRuntimeOperations = Readonly<{
  /**
   * The live text an owner reads at a point, which can exceed the readable text carried by an
   * already-captured snapshot node (an editable field whose value is longer than its label).
   * Declared `preferred`, never `required`: every consumer's required path answers from the
   * snapshot tree, so an owner without this operation still executes the command completely.
   *
   * Returns a closed typed outcome rather than a bare string, so a consumer never has to
   * distinguish "no text here" from "the read blew up" by catching.
   */
  readTextAtPoint(input: ReadTextAtPointInput): Promise<ElementTextReadOutcome>;
}>;

export type ElementTextRuntimeOperationFacts = Readonly<{
  readTextAtPoint: RuntimeOperationFact;
}>;

export function elementTextRuntimeOperationFacts(
  input: ElementTextRuntimeOperationFacts,
): ElementTextRuntimeOperationFacts {
  return Object.freeze({ readTextAtPoint: input.readTextAtPoint });
}

/**
 * The existing per-family read mechanics, injected by composition. Families reach their own
 * tools through this port rather than importing root modules, matching the snapshot runtime's
 * interactor-resolver seam.
 */
export type ElementTextRuntimeHost = Readonly<{
  readTextAtPoint(device: DeviceInfo, input: ReadTextAtPointInput): Promise<ElementTextReadOutcome>;
}>;

/** Captures one selected owner's read authority for the lifetime of a request binding. */
export function bindElementTextRuntime(
  params: Readonly<{
    device: DeviceInfo;
    host: ElementTextRuntimeHost;
  }>,
): ElementTextRuntimeOperations {
  return Object.freeze({
    readTextAtPoint: async (input: ReadTextAtPointInput) =>
      await params.host.readTextAtPoint(params.device, input),
  });
}
