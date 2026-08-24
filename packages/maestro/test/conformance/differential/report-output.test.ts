import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { writeReports } from './report-output.ts';

test('writes the typed differential report envelope', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'differential-report-'));
  try {
    writeReports(outDir, 'ios', []);
    const report = JSON.parse(
      fs.readFileSync(path.join(outDir, 'differential-report.json'), 'utf8'),
    );
    assert.deepEqual(report, { platform: 'ios', reports: [] });
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
