import type { DeviceTarget, PublicPlatform } from '@agent-device/kernel/device';
import type { RunnerContext } from './interactor-types.ts';
import type { Rect } from '@agent-device/kernel/snapshot';
import type { SnapshotProducerIdentity } from './snapshot-producers.ts';

export type AuditFindingKind =
  | 'small-target'
  | 'missing-name'
  | 'ambiguous-name'
  | 'covered-control';

/** `warning` asks for review; `observation` reports a fact the screen already proved. */
export type AuditSeverity = 'warning' | 'observation';

export type AuditSizeUnit = 'pt' | 'dp';

/** A `small-target` finding's measured size and the recommendation, all in `unit`. */
export type AuditSizeDetail = {
  unit: AuditSizeUnit;
  width: number;
  height: number;
  recommendedSize: number;
};

/** An `ambiguous-name` finding's shared label and how many controls of the role share it. */
export type AuditNameDetail = {
  /** The name the controls share, spelled as the reporting control exposes it. */
  name: string;
  /** Controls of this role carrying that name on the audited screen, including this one. */
  count: number;
};

type AuditFindingBase = {
  /** Plain ref (`@e7`) of the node. It is valid only with the response's `refsGeneration`. */
  ref: string;
  /** The node's rect in snapshot coordinates (points on iOS, physical pixels on Android). */
  rect?: Rect;
  /** Control role as the snapshot presents it, such as `button`. */
  role: string;
  /** Accessible label from the captured node. */
  label?: string;
  /** Accessibility identifier or resource id from the captured node. */
  identifier?: string;
};

export type AuditFinding =
  | (AuditFindingBase & { kind: 'small-target'; severity: 'warning'; detail: AuditSizeDetail })
  | (AuditFindingBase & { kind: 'missing-name'; severity: 'warning' })
  | (AuditFindingBase & { kind: 'ambiguous-name'; severity: 'warning'; detail: AuditNameDetail })
  | (AuditFindingBase & { kind: 'covered-control'; severity: 'observation' });

export type IosNativeAuditType =
  | 'contrast'
  | 'dynamicType'
  | 'elementDetection'
  | 'hitRegion'
  | 'sufficientElementDescription'
  | 'textClipped'
  | 'trait'
  | `unknown:${string}`;

/** Native geometry can identify one node in the preceding snapshot. */
export type NativeAuditFinding = {
  ref?: string;
  role?: string;
  label?: string;
  source: 'native';
  kind: 'native';
  severity: 'warning';
  description: string;
  rect?: Rect;
} & (
  | { platform: 'ios'; auditType: IosNativeAuditType }
  | { platform: 'android'; auditType: string }
);

export type AuditContext = {
  platform: PublicPlatform;
  producer?: SnapshotProducerIdentity;
  /** Absent means a mobile target. */
  target?: DeviceTarget;
  /** Physical pixels per dp, from the Android capture. */
  pixelDensity?: number;
  /**
   * Whether the capture cut the tree short. Absent means the producer cannot say, which is not
   * the same as `false`.
   */
  truncated?: boolean;
};

export type AuditChecks = {
  /** `unknown`: the producer cannot report truncation, so the tree may be partial. */
  snapshot: 'complete' | 'partial' | 'unknown';
};

/**
 * TalkBack's swipe order estimated from the capture, one entry per Android application window in
 * capture order. It is computed with a port of TalkBack 16.2's traversal and focus rules, not
 * observed from TalkBack. It leaves out auto-scroll, scrolling past the screen, the order across
 * windows, and web content.
 */
export type AuditScreenReaderOrder = {
  estimatedFrom: 'talkback-16.2';
  windows: AuditScreenReaderWindowOrder[];
};

export type AuditScreenReaderWindowOrder = {
  /** Plain refs in swipe order. They are valid only with the response's `refsGeneration`. */
  refs: string[];
  /** Stops with no node in the snapshot, left out of `refs`. Absent when none. */
  omittedStops?: number;
};

export type AuditResult = {
  findings: AuditFinding[];
  /** Android only, from a snapshot helper that reports the facts the estimate reads. */
  screenReaderOrder?: AuditScreenReaderOrder;
  guidance: Partial<Record<AuditFindingKind, string>>;
  checks: AuditChecks;
  /** Checks the audit could not run or could only partly run, with the reason. */
  limitations: string[];
};

export type AuditSnapshotCommandResult = Omit<AuditResult, 'findings'> & {
  findings: (AuditFinding | NativeAuditFinding)[];
  /**
   * Ref-frame epoch the finding and screen-reader order refs were minted from (ADR 0014). Present
   * only when the audit returned a ref; pair each ref with it (`@e7~s<refsGeneration>`) before a mutation.
   */
  refsGeneration?: number;
  warnings?: string[];
};

/** Every plain ref an audit result returns: finding refs, then screen-reader order refs. */
export function auditResultRefs(
  result: Pick<AuditSnapshotCommandResult, 'findings' | 'screenReaderOrder'>,
): string[] {
  return [
    ...result.findings.flatMap((finding) => (finding.ref ? [finding.ref] : [])),
    ...(result.screenReaderOrder?.windows.flatMap((window) => window.refs) ?? []),
  ];
}

export type AccessibilityAuditInput = Readonly<RunnerContext>;

export type AccessibilityAuditRuntimeOperations = Readonly<{
  accessibilityAudit(input: AccessibilityAuditInput): Promise<NativeAuditFinding[]>;
}>;
