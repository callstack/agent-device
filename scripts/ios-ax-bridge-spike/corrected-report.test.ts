import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { buildCorrectedReport, readSpikeReport, readTargetedArtifact } from './corrected-report.ts';
import { renderCorrectedMarkdown } from './corrected-markdown.ts';

const SOURCE = 'docs/evidence/ios-simulator-ax-bridge-2026-09-01-final.json.gz';
const TARGETED = 'docs/evidence/ios-simulator-ax-bridge-2026-09-02-targeted.json.gz';

describe('corrected Simulator AX bridge report', () => {
  test('evaluates every hard gate from the checked-in artifacts and renders the decision', () => {
    const report = buildCorrectedReport({
      sourcePath: SOURCE,
      source: readSpikeReport(path.resolve(SOURCE)),
      targetedPath: TARGETED,
      targeted: readTargetedArtifact(path.resolve(TARGETED)),
    });

    expect(report.hardGates.warm.status).toBe('PASS');
    expect(report.hardGates.relaunch.status).toBe('PASS');
    expect(report.hardGates.liveRecovery.status).toBe('PASS');
    expect(report.hardGates.hierarchy.status).toBe('PASS');
    expect(report.hierarchy.interpretation).toBe('nested-tree');
    expect(report.hierarchy.observedTraversalDepth).toBeGreaterThan(10);
    expect(report.guestMechanism.client).toBe('node-direct-socket');
    expect(report.bootstrap).toHaveLength(5);
    expect(report.bootstrap.every((sample) => sample.readinessAttempts >= 1)).toBe(true);
    const failedGates = Object.entries(report.hardGates).filter(
      ([, gate]) => gate.status === 'FAIL',
    );
    expect(report.decision).toBe(failedGates.length === 0 ? 'GO' : 'NO-GO');
    expect(renderCorrectedMarkdown(report)).toContain(`Decision: **${report.decision}**`);
  });
});
