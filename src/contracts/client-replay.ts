// The public API vocabulary for replay and batch execution.

import type { SessionRuntimeHints } from '../kernel/contracts.ts';
import type {
  AgentDeviceRequestOverrides,
  AgentDeviceSelectionOptions,
} from './client-connection.ts';

export type ReplayRunOptions = AgentDeviceRequestOverrides &
  AgentDeviceSelectionOptions & {
    path: string;
    runtime?: SessionRuntimeHints;
    /**
     * @deprecated ADR 0012 migration step 6: `--update` no longer rewrites
     * the script. Accepted for backward compatibility; every divergence
     * already carries ranked selector suggestions regardless of this flag.
     */
    update?: boolean;
    /** @deprecated Use backend: 'maestro'. */
    maestro?: boolean;
    backend?: string;
    env?: string[];
    timeoutMs?: number;
    /**
     * ADR 0012 decision 4 / migration step 5: resume at this 1-based plan
     * step, skipping `1..resumeFrom-1` without executing them. Requires
     * `resumePlanDigest` from the divergence report that reported this
     * step as the failure. `replay` only — `test` has no resume fields.
     */
    resumeFrom?: number;
    /** The `resume.planDigest` from the divergence report `resumeFrom` came from. */
    resumePlanDigest?: string;
    /**
     * ADR 0012 decision 6, R1/R6: arms agent-supervised re-record repair
     * from this replay attempt onward. Optional string value is the healed
     * `.ad`'s output path; absent one, it defaults to the `<path>` sibling
     * `<stem>.healed.ad` when the repair ends with `close --save-script`.
     */
    saveScript?: boolean | string;
    /** #1258: overwrite an existing --save-script target instead of refusing. Alias: --overwrite. */
    force?: boolean;
  };

export type ReplayTestOptions = AgentDeviceRequestOverrides &
  AgentDeviceSelectionOptions & {
    paths: string[];
    runtime?: SessionRuntimeHints;
    update?: boolean;
    /** @deprecated Use backend: 'maestro'. */
    maestro?: boolean;
    backend?: string;
    env?: string[];
    failFast?: boolean;
    timeoutMs?: number;
    retries?: number;
    recordVideo?: boolean;
    artifactsDir?: string;
    /** @deprecated Use the CLI --reporter junit:<path> or --report-junit <path>. */
    reportJunit?: string;
    shardAll?: number;
    shardSplit?: number;
  };

export type BatchStep = {
  command: string;
  input: Record<string, unknown>;
  runtime?: SessionRuntimeHints;
};

export type BatchRunOptions = AgentDeviceRequestOverrides & {
  steps: BatchStep[];
  onError?: 'stop';
  maxSteps?: number;
  out?: string;
};
