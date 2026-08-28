import fc from 'fast-check';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { PROPERTY_RUNS, replayScriptArb } from '../../__tests__/test-utils/property-arbitraries.ts';
import {
  formatPortableActionLine,
  formatTargetAnnotationLines,
  parseReplayScriptDetailed,
} from '@agent-device/ad-script';
import type { SessionAction } from '@agent-device/contracts/session';

// `@agent-device/ad-script` (#1478 P5) owns the parser and line formatter;
// this property lives at root because its generator (`replayScriptArb`) is
// derived from the root command catalog and selector grammar, which the
// codec package cannot import (R11 forbids a package reaching into root
// `src/`). See `packages/ad-script/src/internal/__tests__/script.test.ts` for
// this codec's example-based coverage.

function formatReplayScriptForTest(actions: SessionAction[]): string {
  const lines: string[] = [];
  for (const action of actions) {
    lines.push(...formatTargetAnnotationLines(action));
    lines.push(formatPortableActionLine(action, { runtimeIncludeAllPositionals: true }));
  }
  return `${lines.join('\n')}\n`;
}

// Property, not another example: `.ad` scripts are written by hand, recorded,
// and rewritten, so the parser and the line formatter must agree on ONE
// canonical form — re-serializing a parsed script has to be a fixed point.
// Generated lines come from the shared `.ad` generator, so a new command shape
// extends the generator rather than adding another pinned script here.
test('serializing a parsed script is a fixed point for generated scripts', () => {
  fc.assert(
    fc.property(replayScriptArb, (script) => {
      const parsed = parseReplayScriptDetailed(script).actions;
      const canonical = formatReplayScriptForTest(parsed);
      const reparsed = parseReplayScriptDetailed(canonical).actions;
      assert.equal(formatReplayScriptForTest(reparsed), canonical);
      // The action identity survives the rewrite: same commands, same targets.
      assert.deepEqual(
        reparsed.map((action) => [action.command, action.positionals]),
        parsed.map((action) => [action.command, action.positionals]),
      );
    }),
    { numRuns: PROPERTY_RUNS },
  );
});
