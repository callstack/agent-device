// The public API vocabulary for snapshot, screenshot and diff capture.

import type { SessionSurface } from './session-surface.ts';
import type { PublicSnapshotCaptureAnnotations } from './snapshot-capture-annotations.ts';
import type { SnapshotDiagnosticsSummary } from './snapshot-diagnostics.ts';
import type {
  SnapshotNode,
  SnapshotUnchanged,
  SnapshotVisibility,
} from '@agent-device/kernel/snapshot';
import type { ScreenshotResultData } from './snapshot-types.ts';
import type {
  AgentDeviceIdentifiers,
  AgentDeviceRequestOverrides,
  AgentDeviceSelectionOptions,
  DeviceCommandBaseOptions,
} from './client-connection.ts';

export type CaptureSnapshotOptions = AgentDeviceRequestOverrides &
  AgentDeviceSelectionOptions & {
    interactiveOnly?: boolean;
    depth?: number;
    scope?: string;
    raw?: boolean;
    forceFull?: boolean;
    timeoutMs?: number;
    /**
     * #1271 stage 2 (ADR 0012 amendment): `snapshot` is observation-only and
     * excluded from a repair-armed heal by default; `record` forces it
     * through. Mutually exclusive with `noRecord`.
     */
    noRecord?: boolean;
    record?: boolean;
  };

export type CaptureSnapshotResult = {
  nodes: SnapshotNode[];
  truncated: boolean;
  appName?: string;
  appBundleId?: string;
  visibility?: SnapshotVisibility;
  unchanged?: SnapshotUnchanged;
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
  identifiers: AgentDeviceIdentifiers;
  /**
   * ADR 0014: the response-level ref-frame epoch the plain node refs were minted
   * from. A ref-issuing snapshot carries it ONCE (nodes stay plain `@e12` for the
   * token budget); pair a ref with it (`@e12~s<refsGeneration>`) before a mutation.
   */
  refsGeneration?: number;
  /**
   * Digest response view only: a capped list of `{ ref, label? }` pairs taken
   * from the full `nodes` tree so the MCP layer can still pin refs when the
   * default-level `nodes` payload is intentionally omitted.
   */
  refs?: Array<{ ref: string; label?: string }>;
} & PublicSnapshotCaptureAnnotations;

export type CaptureScreenshotOptions = AgentDeviceRequestOverrides & {
  path?: string;
  overlayRefs?: boolean;
  pixelDensity?: number;
  fullscreen?: boolean;
  maxSize?: number;
  stabilize?: boolean;
  normalizeStatusBar?: boolean;
  surface?: SessionSurface;
};

export type CaptureScreenshotResult = ScreenshotResultData & {
  path: string;
  identifiers: AgentDeviceIdentifiers;
};

export type CaptureDiffOptions = DeviceCommandBaseOptions &
  Pick<CaptureSnapshotOptions, 'interactiveOnly' | 'depth' | 'scope' | 'raw'> & {
    kind: 'snapshot';
    out?: string;
  };

export type SelectorSnapshotCommandOptions = Pick<
  CaptureSnapshotOptions,
  'depth' | 'scope' | 'raw'
>;

export type FindSnapshotCommandOptions = Pick<CaptureSnapshotOptions, 'depth' | 'raw'>;
