import type { DeviceTarget, PublicPlatform } from '@agent-device/kernel/device';
import type { Rect } from '@agent-device/kernel/snapshot';

export type AuditFindingKind = 'small-target' | 'missing-name' | 'covered-control';

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

type AuditFindingBase = {
  /** Plain ref (`@e7`) of the node. It is valid only with the response's `refsGeneration`. */
  ref: string;
  /** The node's rect in snapshot coordinates (points on iOS, physical pixels on Android). */
  rect?: Rect;
  /** Control role as the snapshot presents it, such as `button`. */
  role: string;
};

export type AuditFinding =
  | (AuditFindingBase & { kind: 'small-target'; severity: 'warning'; detail: AuditSizeDetail })
  | (AuditFindingBase & { kind: 'missing-name'; severity: 'warning' })
  | (AuditFindingBase & { kind: 'covered-control'; severity: 'observation' });

export type AuditContext = {
  platform: PublicPlatform;
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

export type AuditResult = {
  findings: AuditFinding[];
  checks: AuditChecks;
  /** Checks the audit could not run or could only partly run, with the reason. */
  limitations: string[];
};

export type AuditSnapshotCommandResult = AuditResult & {
  /**
   * Ref-frame epoch the finding refs were minted from (ADR 0014). Present only when the audit
   * returned a finding; pair each ref with it (`@e7~s<refsGeneration>`) before a mutation.
   */
  refsGeneration?: number;
  warnings?: string[];
};
