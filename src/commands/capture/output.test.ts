import { test } from 'vitest';
import assert from 'node:assert/strict';
import { attachRefs, type RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { CaptureSnapshotResult } from '@agent-device/contracts/client';
import { iosTargetActivationDisclosure } from '@agent-device/contracts/ios-target-activation';
import { formatCliOutput } from '../cli-output.ts';
import { captureCliOutputFormatters, snapshotCliOutput } from './output.ts';

function buildResult(raw: RawSnapshotNode[]): CaptureSnapshotResult {
  return {
    nodes: attachRefs(raw),
    truncated: false,
    identifiers: { session: 'qa' },
  };
}

const REPEATED_CHAIN: RawSnapshotNode[] = [
  { index: 0, type: 'ScrollView', label: 'Anthropic - Headquarters, 548 Market St', depth: 0 },
  {
    index: 1,
    type: 'Other',
    label: 'Anthropic - Headquarters, 548 Market St',
    depth: 1,
    parentIndex: 0,
  },
  {
    index: 2,
    type: 'Button',
    label: 'Anthropic - Headquarters, 548 Market St',
    depth: 2,
    parentIndex: 1,
  },
  {
    index: 3,
    type: 'Button',
    label: 'Anthropic - Headquarters, 548 Market St',
    depth: 3,
    parentIndex: 2,
  },
];

test('default (non-raw) output dedups repeated ancestor labels in both text and json', async () => {
  const output = await snapshotCliOutput({ result: buildResult(REPEATED_CHAIN) });

  const jsonNodes = (output.jsonData as { nodes: Array<Record<string, unknown>> }).nodes;
  assert.equal(jsonNodes[0]!.label, 'Anthropic - Headquarters, 548 Market St');
  assert.equal(jsonNodes[1]!.label, undefined);
  assert.equal(jsonNodes[1]!.inheritsLabel, true);
  assert.equal(jsonNodes[2]!.inheritsLabel, true);
  assert.equal(jsonNodes[3]!.inheritsLabel, true);

  const occurrences = output.text!.split('Anthropic - Headquarters, 548 Market St').length - 1;
  assert.equal(occurrences, 1);
  assert.match(output.text!, /same label as parent/);
});

test('--raw preserves the original repeated labels byte-for-byte', async () => {
  const output = await snapshotCliOutput({ result: buildResult(REPEATED_CHAIN), raw: true });

  const jsonNodes = (output.jsonData as { nodes: Array<Record<string, unknown>> }).nodes;
  for (const node of jsonNodes) {
    assert.equal(node.label, 'Anthropic - Headquarters, 548 Market St');
    assert.equal(node.inheritsLabel, undefined);
  }
  const occurrences = output.text!.split('Anthropic - Headquarters, 548 Market St').length - 1;
  assert.equal(occurrences, 4);
});

test('distinct labels across the chain are all preserved', async () => {
  const output = await snapshotCliOutput({
    result: buildResult([
      { index: 0, type: 'ScrollView', label: 'Map', depth: 0 },
      { index: 1, type: 'Button', label: 'Anthropic HQ', depth: 1, parentIndex: 0 },
    ]),
  });

  const jsonNodes = (output.jsonData as { nodes: Array<Record<string, unknown>> }).nodes;
  assert.equal(jsonNodes[0]!.label, 'Map');
  assert.equal(jsonNodes[1]!.label, 'Anthropic HQ');
});

test('snapshot output presents the materialized fallback screenshot path', async () => {
  const result = {
    ...buildResult([]),
    fallbackScreenshotPath: '/client/artifacts/snapshot-fallback.png',
  };

  const output = await snapshotCliOutput({ result });

  assert.equal(
    (output.jsonData as Record<string, unknown>).fallbackScreenshotPath,
    '/client/artifacts/snapshot-fallback.png',
  );
  assert.match(
    output.text ?? '',
    /Captured a screenshot of this screen automatically as visual truth: \/client\/artifacts\/snapshot-fallback\.png/,
  );
});

/**
 * The rendered surface an agent actually reads after the runner repaired foreground (#2682): the
 * disclosure is printed, and the structured fact survives the JSON projection so a scripted caller
 * never has to parse the sentence.
 */
test('a repaired capture renders the disclosure and keeps the structured fact', async () => {
  const fact = {
    reason: 'stale_target',
    priorState: 'runningBackground',
    otherActiveApplicationPid: 4562,
  } as const;
  const output = await snapshotCliOutput({
    result: {
      ...buildResult(REPEATED_CHAIN),
      warnings: [iosTargetActivationDisclosure(fact)],
      targetActivation: fact,
    } as CaptureSnapshotResult,
  });

  assert.match(String(output.text), /prior state runningBackground/);
  assert.match(String(output.text), /drive the other app in its own session/);
  assert.deepEqual((output.jsonData as { targetActivation?: unknown }).targetActivation, {
    reason: 'stale_target',
    priorState: 'runningBackground',
    otherActiveApplicationPid: 4562,
  });
});

test('JSON output keeps snapshot quality and warnings and drops capture analysis and freshness', async () => {
  const snapshotQuality = { state: 'healthy', backend: 'tree' };
  const output = await snapshotCliOutput({
    result: {
      nodes: attachRefs([{ index: 0, depth: 0, type: 'android.widget.TextView', label: 'Albums' }]),
      truncated: false,
      identifiers: { session: 'qa' },
      snapshotQuality,
      warnings: ['backend warning from interaction capture'],
      analysis: { rawNodeCount: 1, maxDepth: 0 },
      freshness: { action: 'swipe', retryCount: 0, staleAfterRetries: false },
    } as unknown as CaptureSnapshotResult,
  });

  assert.deepEqual(
    (output.jsonData as { snapshotQuality?: unknown }).snapshotQuality,
    snapshotQuality,
  );
  assert.deepEqual((output.jsonData as { warnings?: unknown }).warnings, [
    'backend warning from interaction capture',
  ]);
  const jsonData = output.jsonData as Record<string, unknown>;
  assert.equal('analysis' in jsonData, false);
  assert.equal('freshness' in jsonData, false);
});

test('routes snapshot diagnostics warning to stderr output', async () => {
  const output = await snapshotCliOutput({
    result: {
      nodes: [],
      truncated: false,
      identifiers: {},
      snapshotDiagnostics: {
        stats: {
          count: 2,
          p50Ms: 400,
          p95Ms: 1_900,
          maxMs: 1_900,
          slowThresholdMs: 1_500,
          platform: 'ios',
        },
        warning: 'Warning: ios snapshots are slow in this run: p95 1900ms over 2 captures.',
      },
    },
  });

  assert.equal(
    output.stderr,
    'Warning: ios snapshots are slow in this run: p95 1900ms over 2 captures.\n',
  );
  assert.ok(!output.text?.includes('snapshots are slow'));
});

// #1796: the Android revoke warning rides `warnings`; the human CLI line must show it. The line is
// appended by `formatCliOutput` (#2682), so that is where the guarantee is asserted; the formatter
// itself only renders the response's own message.
test('settings renders response warnings after the message', async () => {
  const warning = 'android.permission.CAMERA was granted before this revoke, and Android …';
  const response = {
    setting: 'permission',
    state: 'reset',
    message: 'Updated setting: permission',
    warnings: [warning],
  };

  const output = await formatCliOutput({
    env: process.env,
    name: 'settings',
    input: {},
    result: response,
  });
  assert.equal(output?.text, `Updated setting: permission\nWarning: ${warning}`);
  assert.deepEqual((output!.data as { warnings?: string[] }).warnings, [warning]);

  const rendered = await captureCliOutputFormatters.settings!({
    env: process.env,
    input: {},
    result: response,
  });
  assert.equal(rendered.text, 'Updated setting: permission');
});
