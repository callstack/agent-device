import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  BOUNDARY_COMMAND_CLASSES,
  BOUNDARY_FAULTS,
  BOUNDARY_FAULT_MATRIX,
  type BoundaryCoverage,
} from '../test-utils/boundary-fault-matrix.ts';

test('boundary fault matrix is complete across both declared axes', () => {
  assert.deepEqual(Object.keys(BOUNDARY_FAULT_MATRIX).sort(), [...BOUNDARY_FAULTS].sort());

  for (const fault of BOUNDARY_FAULTS) {
    const row = BOUNDARY_FAULT_MATRIX[fault];
    assert.deepEqual(Object.keys(row).sort(), [...BOUNDARY_COMMAND_CLASSES].sort(), fault);
    for (const commandClass of BOUNDARY_COMMAND_CLASSES) {
      assertBoundaryCoverage(row[commandClass], `${fault}/${commandClass}`);
    }
  }
});

function assertBoundaryCoverage(cell: BoundaryCoverage, cellName: string): void {
  if (cell.kind === 'not-applicable') {
    assert.ok(cell.reason.trim(), `${cellName} must explain why it is not applicable`);
    return;
  }

  assert.ok(cell.evidence.length > 0, `${cellName} must name executable evidence`);
  assert.ok(cell.invariants.length > 0, `${cellName} must name asserted invariants`);
  for (const evidence of cell.evidence) {
    assert.ok(evidence.trim(), `${cellName} has empty evidence`);
    const evidencePath = evidence.split(':', 1)[0];
    if (!evidencePath) throw new Error(`${cellName} has no evidence path`);
    assert.equal(
      fs.existsSync(path.resolve(process.cwd(), evidencePath)),
      true,
      `${cellName} points at missing evidence ${evidencePath}`,
    );
  }
}
