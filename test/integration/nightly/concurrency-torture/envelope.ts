// Standard scheduled-lane artifact envelope (#1430) for the concurrency torture
// lane (#1416). Builds the shared `LaneEnvelope` from scripts/lib/lane-envelope.ts
// so the #1430 health watcher parses one dialect, not a lane-local one; the
// lane's seed range / run count ride in the typed `data` payload, and the lane
// source hash maps onto the generic `configHash`. Written when TORTURE_ENVELOPE
// names an output path (set by the nightly workflow, which uploads it as an
// artifact); a no-op otherwise.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  laneEnvelope,
  type LaneEnvelope,
  type LaneResult,
} from '../../../../scripts/lib/lane-envelope.ts';

const LANE_ID = 'concurrency-torture';

export type TortureEnvelopeData = {
  issue: number;
  seedRange: { start: number; end: number };
  runs: number;
};

export type TortureEnvelope = LaneEnvelope<TortureEnvelopeData>;

/** Content hash of the lane's own source, so config/tool drift is visible. */
function laneSourceHash(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = [
    ...fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => path.join(dir, name)),
    path.join(dir, '..', 'concurrency-torture.test.ts'),
  ].sort();
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.basename(file));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex');
}

export function buildEnvelope(params: {
  seedStart: number;
  runs: number;
  startedAtMs: number;
  result: LaneResult;
}): TortureEnvelope {
  const end = params.seedStart + params.runs;
  return laneEnvelope<TortureEnvelopeData>({
    lane: LANE_ID,
    commit: process.env.GITHUB_SHA?.trim() || '',
    tool: { node: process.version },
    configHash: laneSourceHash(),
    seed: `${params.seedStart}-${end - 1}`,
    startedAtMs: params.startedAtMs,
    result: params.result,
    data: {
      issue: 1416,
      seedRange: { start: params.seedStart, end },
      runs: params.runs,
    },
  });
}

/** Write the envelope to TORTURE_ENVELOPE when set; returns the path or null. */
export function writeEnvelopeIfRequested(envelope: TortureEnvelope): string | null {
  const target = process.env.TORTURE_ENVELOPE?.trim();
  if (!target) return null;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(envelope, null, 2)}\n`);
  return target;
}
