// Standard scheduled-lane artifact envelope (#1430) for the concurrency torture
// lane (#1416). #1430 requires every scheduled lane to emit a machine-readable
// envelope — schema version, commit SHA, tool/config hashes, seed range,
// duration, and result — so the observatory can detect a lane going dark or
// stale. Written when TORTURE_ENVELOPE names an output path (set by the nightly
// workflow, which uploads it as an artifact); a no-op otherwise.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENVELOPE_SCHEMA_VERSION = 1;

export type LaneEnvelope = {
  schemaVersion: number;
  lane: string;
  issue: number;
  commitSha: string | null;
  tool: { node: string };
  sourceHash: string;
  seedRange: { start: number; end: number };
  runs: number;
  durationMs: number;
  result: 'pass' | 'fail';
};

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
  durationMs: number;
  result: 'pass' | 'fail';
}): LaneEnvelope {
  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    lane: 'concurrency-torture',
    issue: 1416,
    commitSha: process.env.GITHUB_SHA?.trim() || null,
    tool: { node: process.version },
    sourceHash: laneSourceHash(),
    seedRange: { start: params.seedStart, end: params.seedStart + params.runs },
    runs: params.runs,
    durationMs: params.durationMs,
    result: params.result,
  };
}

/** Write the envelope to TORTURE_ENVELOPE when set; returns the path or null. */
export function writeEnvelopeIfRequested(envelope: LaneEnvelope): string | null {
  const target = process.env.TORTURE_ENVELOPE?.trim();
  if (!target) return null;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(envelope, null, 2)}\n`);
  return target;
}
