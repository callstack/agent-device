// Per-key matching semantics: what each selector key compares a node against.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { parseSelectorChain } from './parse.ts';
import { findSelectorChainMatch, resolveSelectorChain } from './resolve.ts';
import { loginFormNodes } from './__tests__/login-form-nodes.ts';

test('resolveSelectorChain matches newline labels decoded from replay selectors', () => {
  const newlineNodes: SnapshotState['nodes'] = [
    {
      ref: 'n1',
      index: 0,
      type: 'XCUIElementTypeButton',
      label: 'Switch\nMy Community',
      rect: { x: 0, y: 0, width: 120, height: 44 },
      enabled: true,
      hittable: true,
    },
  ];
  const chain = parseSelectorChain(String.raw`label="Switch\nMy Community"`);
  const resolved = resolveSelectorChain(newlineNodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
  });

  assert.ok(resolved);
  assert.equal(resolved.node.ref, 'n1');
});

test('text selector matches extractNodeText semantics (first non-empty field)', () => {
  const chainByLabel = parseSelectorChain('text=Email');
  const chainById = parseSelectorChain('text=login_email');
  const resolvedLabel = resolveSelectorChain(loginFormNodes, chainByLabel, {
    platform: 'ios',
    requireUnique: true,
  });
  const resolvedId = resolveSelectorChain(loginFormNodes, chainById, {
    platform: 'ios',
    requireUnique: true,
  });
  assert.ok(resolvedLabel);
  assert.equal(resolvedLabel.node.ref, 'e1');
  assert.equal(resolvedId, null);
});

test('role selector normalization matches Android class names by leaf type', () => {
  const androidNodes: SnapshotState['nodes'] = [
    {
      ref: 'a1',
      index: 0,
      type: 'android.widget.Button',
      label: 'Continue',
      identifier: 'auth_continue',
      rect: { x: 0, y: 0, width: 120, height: 44 },
      enabled: true,
      hittable: true,
    },
  ];
  const chain = parseSelectorChain('role=button label="Continue"');
  const resolved = resolveSelectorChain(androidNodes, chain, {
    platform: 'android',
    requireRect: true,
    requireUnique: true,
  });
  assert.ok(resolved);
  assert.equal(resolved.node.ref, 'a1');
});

test('focused selector matches snapshot focus state', () => {
  const tvNodes: SnapshotState['nodes'] = [
    {
      ref: 'tv1',
      index: 0,
      type: 'android.widget.TextView',
      label: 'Search',
      focused: false,
    },
    {
      ref: 'tv2',
      index: 1,
      type: 'android.widget.Button',
      label: 'Play',
      focused: true,
    },
  ];
  const chain = parseSelectorChain('focused=true');
  const resolved = resolveSelectorChain(tvNodes, chain, {
    platform: 'android',
    requireUnique: true,
  });

  assert.ok(resolved);
  assert.equal(resolved.node.ref, 'tv2');
});

// ── appName / windowTitle selectors ──────────────────────────────────────

test('appName selector matches nodes with appName field', () => {
  const desktopNodes: SnapshotState['nodes'] = [
    {
      ref: 'd1',
      index: 0,
      type: 'Button',
      label: 'OK',
      appName: 'Calculator',
      windowTitle: 'Main Window',
      rect: { x: 0, y: 0, width: 80, height: 30 },
      hittable: true,
    },
    {
      ref: 'd2',
      index: 1,
      type: 'Button',
      label: 'OK',
      appName: 'TextEditor',
      windowTitle: 'Untitled',
      rect: { x: 0, y: 0, width: 80, height: 30 },
      hittable: true,
    },
  ];

  // Match by appName — should disambiguate two OK buttons
  const chain1 = parseSelectorChain('label=OK appname=Calculator');
  const match1 = findSelectorChainMatch(desktopNodes, chain1, { platform: 'linux' });
  assert.ok(match1);
  assert.equal(match1.matches, 1);

  // Match by windowTitle
  const chain2 = parseSelectorChain('windowtitle=Untitled');
  const match2 = findSelectorChainMatch(desktopNodes, chain2, { platform: 'linux' });
  assert.ok(match2);
  assert.equal(match2.matches, 1);

  // Case-insensitive key (appName vs appname) and value
  const chain3 = parseSelectorChain('appName=calculator');
  const match3 = findSelectorChainMatch(desktopNodes, chain3, { platform: 'linux' });
  assert.ok(match3);
  assert.equal(match3.matches, 1);
});
