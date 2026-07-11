import { serializeSnapshotResult } from '../../contracts/result-serialization.ts';
import type { CaptureSnapshotResult } from '../../client/client-types.ts';
import { dedupeInheritedSnapshotLabels } from '../../snapshot/snapshot-label-dedup.ts';
import { formatSnapshotText } from '../../utils/output.ts';
import type { CliOutput } from '../command-contract.ts';
import { messageOutput, type CliOutputFormatter } from '../output-common.ts';

export function snapshotCliOutput(params: {
  result: CaptureSnapshotResult;
  raw?: boolean;
  interactiveOnly?: boolean;
  scope?: string;
  depth?: number;
}): CliOutput {
  // --raw is the full-fidelity escape hatch (e.g. rect fallback lookups): keep
  // it byte-for-byte, undeduped. Every other presentation (default text and
  // --json) collapses labels/identifiers that repeat an ancestor's value.
  // A non-default responseLevel (e.g. digest) can hand back a payload with no
  // `nodes` array at all; leave it untouched rather than assume the shape.
  const presentedResult =
    params.raw || !Array.isArray(params.result.nodes)
      ? params.result
      : { ...params.result, nodes: dedupeInheritedSnapshotLabels(params.result.nodes) };
  const data = serializeSnapshotResult(presentedResult);
  return {
    data,
    // Programmatic SDK callers can see `unchanged`; CLI --json hides it for schema compatibility.
    jsonData: withoutUnchanged(data),
    stderr: params.result.snapshotDiagnostics?.warning
      ? `${params.result.snapshotDiagnostics.warning}\n`
      : undefined,
    text: formatSnapshotText(data, {
      raw: params.raw,
      flatten: params.interactiveOnly,
      scoped: typeof params.scope === 'string' && params.scope.trim().length > 0,
      depthLimited: typeof params.depth === 'number',
    }),
  };
}

export const captureCliOutputFormatters = {
  snapshot: ({ input, result }) =>
    snapshotCliOutput({
      result: result as Parameters<typeof snapshotCliOutput>[0]['result'],
      raw: input.raw as boolean | undefined,
      interactiveOnly: input.interactiveOnly as boolean | undefined,
      scope: input.scope as string | undefined,
      depth: input.depth as number | undefined,
    }),
  wait: messageOutput,
  alert: messageOutput,
} as const satisfies Record<string, CliOutputFormatter>;

function withoutUnchanged(data: Record<string, unknown>): Record<string, unknown> {
  const { unchanged: _unchanged, ...outputData } = data;
  return outputData;
}
