// Reading a saved failing case back (#1414).
//
// The artifact a nightly failure uploads is the unit of reproduction: `--input-file` re-runs it
// and `--append-corpus` promotes it, so its shape is validated in one place.

import fs from 'node:fs';
import { getFuzzTarget } from './registry.ts';
import type { FuzzTarget } from './target-types.ts';

export function readSavedCase(inputFile: string): { target: FuzzTarget; input: string } {
  const saved: unknown = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const { target, input } = Object(saved) as Record<string, unknown>;
  if (typeof target !== 'string' || typeof input !== 'string') {
    throw new Error(`${inputFile} needs string target and input fields.`);
  }
  return { target: getFuzzTarget(target), input };
}
