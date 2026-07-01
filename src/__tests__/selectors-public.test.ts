import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  findSelectorChainMatch,
  formatSelectorFailure,
  isNodeEditable,
  isNodeVisible,
  isSelectorToken,
  parseSelectorChain,
  resolveSelectorChain,
  tryParseSelectorChain,
  type SelectorChain,
  type SelectorDiagnostics,
} from '../sdk/selectors.ts';
import type { SnapshotNode } from '../kernel/snapshot.ts';

const nodes: SnapshotNode[] = [
  {
    ref: 'e1',
    index: 0,
    type: 'android.widget.Button',
    label: 'Continue',
    rect: { x: 0, y: 0, width: 120, height: 48 },
    enabled: true,
  },
  {
    ref: 'e2',
    index: 1,
    type: 'android.widget.EditText',
    label: 'Email',
    rect: { x: 0, y: 64, width: 200, height: 48 },
    enabled: true,
  },
];

test('public selector subpath exposes platform-aware matching helpers', () => {
  const chain: SelectorChain = parseSelectorChain('role=button label="Continue" visible=true');
  const firstSelector = chain.selectors[0]!;
  assert.equal(firstSelector.raw, 'role=button label="Continue" visible=true');
  assert.equal(tryParseSelectorChain(chain.raw)?.raw, chain.raw);
  assert.equal(isSelectorToken('visible=true'), true);

  const match = findSelectorChainMatch(nodes, chain, {
    platform: 'android',
    requireRect: true,
  });
  assert.ok(match);
  assert.equal(match.matches, 1);

  const resolved = resolveSelectorChain(nodes, chain, {
    platform: 'android',
    requireRect: true,
  });
  assert.equal(resolved?.node.ref, 'e1');

  assert.equal(isNodeVisible(nodes[0]!), true);
  assert.equal(isNodeEditable(nodes[1]!, 'android'), true);
});

test('public selector diagnostics format failures', () => {
  const chain = parseSelectorChain('label=Missing');
  const diagnostics: SelectorDiagnostics[] = [{ selector: 'label=Missing', matches: 0 }];

  assert.equal(
    formatSelectorFailure(chain, diagnostics, { unique: false }),
    'Selector did not match (label=Missing -> 0)',
  );
});
