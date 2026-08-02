/**
 * #1478 P5 step 2: cell 8 — repair-suggestion ordering.
 *
 * `buildReplayDivergenceSuggestionForNode` (the divergence/repair-hint
 * suggestion builder) joins `buildSelectorChainForNode`'s output with ` || `
 * into the suggestion's `selector` string verbatim — so the CHAIN's internal
 * priority order (id, then role+label, then label, then value, then text)
 * becomes the ORDER an agent sees candidate selector forms in. The future
 * `buildSelectorCandidates` port operation ("replay repair/divergence
 * suggestions via the existing root selector-chain builder", issue comment
 * 5156017698) must preserve this order verbatim, not just the same set of
 * candidates.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildReplayDivergenceSuggestionForNode } from '../session-replay-divergence.ts';
import { createDaemonReplaySelectorPort } from '../../replay-selector-port.ts';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { toSnapshotNodes } from './session-replay-target-classification-fixtures.ts';
import type { ReplayReportAction } from '../session-replay-report-action.ts';

const identitySanitize = (value: string): string => value;
const port = createDaemonReplaySelectorPort();

test('P5 port cell 8: a node with id, role+label, label, and value all present suggests them in build.ts priority order', () => {
  const nodes = toSnapshotNodes([
    {
      index: 0,
      type: 'Button',
      identifier: 'save-btn',
      label: 'Save Draft',
      value: 'Draft',
      rect: { x: 0, y: 0, width: 80, height: 30 },
    },
  ]);
  const node = nodes[0]!;
  const session = makeIosSession('default');
  const action: ReplayReportAction = { command: 'get', positionals: [], flags: {} };

  const suggestion = buildReplayDivergenceSuggestionForNode({
    node,
    nodes,
    session,
    action,
    basis: 'id',
    sanitize: identitySanitize,
    port,
  });

  assert.equal(
    suggestion.selector,
    'id="save-btn" || role="button" label="Save Draft" || label="Save Draft" || value="Draft"',
  );
});

test('P5 port cell 8: a non-unique id (demoted per #1269) is never suggested, even first — role+label leads instead', () => {
  const nodes = toSnapshotNodes([
    {
      index: 0,
      type: 'TextView',
      identifier: 'android:id/title',
      label: 'Network & internet',
      rect: { x: 0, y: 100, width: 300, height: 48 },
    },
    {
      index: 1,
      type: 'TextView',
      identifier: 'android:id/title',
      label: 'Apps',
      rect: { x: 0, y: 148, width: 300, height: 48 },
    },
  ]);
  const node = nodes[0]!;
  const session = makeIosSession('default');
  const action: ReplayReportAction = { command: 'get', positionals: [], flags: {} };

  const suggestion = buildReplayDivergenceSuggestionForNode({
    node,
    nodes,
    session,
    action,
    basis: 'role-label',
    sanitize: identitySanitize,
    port,
  });

  assert.equal(
    suggestion.selector,
    'role="textview" label="Network & internet" || label="Network & internet"',
  );
});
