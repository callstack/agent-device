/* c8 ignore file */
import fs from 'node:fs';
import path from 'node:path';
import { compareDifferentialCases } from './conformance-harness.ts';
type DifferentialCase = Parameters<typeof compareDifferentialCases>[0][number];

const casePath = process.argv[2];
if (!casePath) {
  throw new Error('usage: replay.ts <case.json>');
}

const input = JSON.parse(fs.readFileSync(path.resolve(casePath), 'utf8')) as {
  cases?: DifferentialCase[];
};
const cases = input.cases ?? [];
if (cases.length !== 1) {
  throw new Error('case.json must contain exactly one differential case');
}

const mismatch = compareDifferentialCases(cases);
if (mismatch) {
  console.error(JSON.stringify(mismatch, null, 2));
  process.exitCode = 1;
} else {
  console.log('replayed ' + cases[0]!.name + ': Swift and TypeScript agree');
}
