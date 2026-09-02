import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildCorrectedReport, readSpikeReport, readTargetedArtifact } from './corrected-report.ts';
import { renderCorrectedMarkdown } from './corrected-markdown.ts';

const SOURCE = 'docs/evidence/ios-simulator-ax-bridge-2026-09-01-final.json.gz';
const TARGETED = 'docs/evidence/ios-simulator-ax-bridge-2026-09-02-targeted.json.gz';

describe('corrected Simulator AX bridge report', () => {
  test('keeps fast resident acquisition separate from failed cold bootstrap and recovery', () => {
    const report = buildCorrectedReport({
      sourcePath: SOURCE,
      source: readSpikeReport(path.resolve(SOURCE)),
      targetedPath: TARGETED,
      targeted: readTargetedArtifact(path.resolve(TARGETED)),
    });

    expect(report.decision).toBe('NO-GO');
    expect(report.hardGates.warm.status).toBe('PASS');
    expect(report.hardGates.relaunch.status).toBe('PASS');
    expect(report.hardGates.nonresidentBootstrap.status).toBe('FAIL');
    expect(report.hardGates.liveRecovery.status).toBe('FAIL');
    expect(renderCorrectedMarkdown(report)).toContain('Decision: **NO-GO**');
  });
});
