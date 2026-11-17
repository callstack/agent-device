import fs from 'node:fs';
import path from 'node:path';
import { redactDiagnosticData } from '@agent-device/kernel/redaction';
import type { CliJsonResult } from '../cli-json.ts';

const fields = [
  'backend',
  'pixelDensity',
  'helperVersion',
  'helperApiVersion',
  'helperTransport',
  'helperSessionReused',
  'installReason',
  'waitForIdleTimeoutMs',
  'waitForIdleQuietMs',
  'timeoutMs',
  'maxDepth',
  'maxNodes',
  'rootPresent',
  'cacheInvalidated',
  'captureMode',
  'systemSurfaceOnly',
  'foregroundWindowPackage',
  'windowCount',
  'nodeCount',
  'helperTruncated',
  'elapsedMs',
  'occlusionScanUnavailable',
] as const;

export function writeSnapshotEvidence(
  dir: string,
  name: 'preflight' | 'catalog',
  session: string,
  startedAtMs: number,
  finishedAtMs: number,
  result: CliJsonResult,
): void {
  const data = result.json?.data;
  const source = data?.androidSnapshot;
  const androidSnapshot: Record<string, string | number | boolean> = {};
  if (source && typeof source === 'object') {
    for (const field of fields) {
      const value: unknown = source[field];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        androidSnapshot[field] = value;
    }
  }
  if (Array.isArray(source?.missingRootWindowTypes)) {
    const types = source.missingRootWindowTypes
      .filter((value: unknown): value is number => typeof value === 'number')
      .slice(0, 20);
    Object.assign(androidSnapshot, { missingRootWindowTypes: types });
  }
  const warnings = Array.isArray(data?.warnings)
    ? data.warnings
        .filter((value: unknown): value is string => typeof value === 'string')
        .slice(0, 20)
    : [];
  const evidence = redactDiagnosticData({
    session,
    startedAtMs,
    finishedAtMs,
    status: result.status,
    androidSnapshot,
    warnings,
  });
  fs.writeFileSync(path.join(dir, `snapshot-${name}.json`), JSON.stringify(evidence, null, 2));
}
