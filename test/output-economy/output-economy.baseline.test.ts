import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { defaultHintForCode, retriableForErrorCode } from '../../src/kernel/errors.ts';
import { runCmdSync } from '../../src/utils/exec.ts';
import {
  findEconomyBudgetIncreases,
  formatEconomyBudgetIncreases,
  type EconomyBaseline,
  type EconomyBudgetWaivers,
} from './budget-guard.ts';
import { measureEconomySample, type EconomyMetrics } from './economy-metrics.ts';
import { renderOutputFixtures } from './render-fixtures.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const baselinePath = 'test/output-economy/output-economy.baseline.json';
const baselineUrl = new URL('./output-economy.baseline.json', import.meta.url);
const waiversUrl = new URL('./output-economy.waivers.json', import.meta.url);
const rendered = await renderOutputFixtures();
const actual = Object.fromEntries(
  Object.entries(rendered.samples).map(([name, sample]) => [name, measureEconomySample(sample)]),
) as Record<string, EconomyMetrics>;
const committedBaseline = JSON.parse(fs.readFileSync(baselineUrl, 'utf8')) as EconomyBaseline;
const waivers = JSON.parse(fs.readFileSync(waiversUrl, 'utf8')) as EconomyBudgetWaivers;
const budgetFloor = readBudgetFloor();
const candidateBaseline =
  process.env.UPDATE_OUTPUT_ECONOMY_BASELINE === '1' ? actual : committedBaseline;
const budgetIncreases = budgetFloor
  ? findEconomyBudgetIncreases(budgetFloor, candidateBaseline, waivers)
  : [];

if (process.env.UPDATE_OUTPUT_ECONOMY_BASELINE === '1' && budgetIncreases.length === 0) {
  fs.writeFileSync(baselineUrl, `${JSON.stringify(actual, null, 2)}\n`);
}

const baseline =
  process.env.UPDATE_OUTPUT_ECONOMY_BASELINE === '1' && budgetIncreases.length === 0
    ? actual
    : committedBaseline;

describe('deterministic output-economy baseline', () => {
  test('does not raise merge-base byte or line budgets', () => {
    expect(budgetIncreases, formatEconomyBudgetIncreases(budgetIncreases)).toEqual([]);
  });

  test('keeps reviewed byte and shape metrics stable', () => {
    expect(actual).toEqual(baseline);
  });

  test('digest views are smaller than their representative default payloads', () => {
    expect(actual['snapshot.digest.json']!.bytes).toBeLessThan(
      actual['snapshot.default.json']!.bytes,
    );
    expect(actual['settle.digest.json']!.bytes).toBeLessThan(actual['settle.default.json']!.bytes);
    expect(actual['selector-read.digest.json']!.bytes).toBeLessThan(
      actual['selector-read.default.json']!.bytes,
    );
    expect(actual['screenshot.digest.json']!.bytes).toBeLessThan(
      actual['screenshot.default.json']!.bytes,
    );
  });
});

function readBudgetFloor(): EconomyBaseline | null {
  const baseRef = resolveBaseRef();
  if (!baseRef) return null;
  const baseBaseline = readBaselineAtRef(baseRef);
  if (baseBaseline) return baseBaseline;

  const commits = runCmdSync(
    'git',
    ['log', '--reverse', '--format=%H', `${baseRef}..HEAD`, '--', baselinePath],
    { cwd: repoRoot, allowFailure: true },
  );
  if (commits.exitCode !== 0) return null;
  for (const commit of commits.stdout.split('\n').filter(Boolean)) {
    const introduced = readBaselineAtRef(commit);
    if (introduced) return introduced;
  }
  return null;
}

function resolveBaseRef(): string | null {
  if (process.env.OUTPUT_ECONOMY_BASE) return process.env.OUTPUT_ECONOMY_BASE;
  const result = runCmdSync('git', ['merge-base', 'HEAD', 'origin/main'], {
    cwd: repoRoot,
    allowFailure: true,
  });
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

function readBaselineAtRef(ref: string): EconomyBaseline | null {
  const result = runCmdSync('git', ['show', `${ref}:${baselinePath}`], {
    cwd: repoRoot,
    allowFailure: true,
  });
  if (result.exitCode !== 0) return null;
  return JSON.parse(result.stdout) as EconomyBaseline;
}

describe('actionability and reliability floors', () => {
  test('snapshot digest preserves actionable refs and their generation', () => {
    expect(rendered.snapshotDigest).toMatchObject({
      refsGeneration: 12,
      refs: [
        { ref: 'e2', label: 'Email' },
        { ref: 'e3', label: 'Place order' },
      ],
    });
  });

  test('settle digests preserve new targets and removals-only fallback targets', () => {
    expect(rendered.settleDigest.settle).toMatchObject({
      refsGeneration: 13,
      refs: [{ ref: 'e4' }, { ref: 'e5' }],
    });
    expect(rendered.settleTailDigest.settle).toMatchObject({
      refsGeneration: 14,
      tail: [
        { ref: 'e7', role: 'button', label: 'Continue' },
        { ref: 'e9', role: 'tab', label: 'Home' },
      ],
    });
  });

  test('selector digest keeps the answer and recovery warning', () => {
    expect(rendered.selectorDigest).toEqual({
      ref: '@e2',
      text: 'qa@example.com',
      warning: 'Recovered from a blocking system dialog',
    });
  });

  test('normalized failures keep stable identity, retryability, and next-step guidance', () => {
    expect(rendered.error).toMatchObject({
      code: 'DEVICE_IN_USE',
      message: 'Device ios-simulator-1 is already used by session checkout',
      hint: 'Run agent-device close --session checkout, then retry.',
      retriable: true,
      details: { reason: 'session-lock' },
    });
    expect(actual['not-settled.default.text']!.hints).toBe(1);
  });

  test('policy-derived failures inherit hint and retry from production normalization', () => {
    expect(rendered.errorPolicyNormalized).toMatchObject({
      code: 'DEVICE_IN_USE',
      hint: defaultHintForCode('DEVICE_IN_USE'),
      retriable: retriableForErrorCode('DEVICE_IN_USE'),
      details: { reason: 'session-lock' },
    });
    expect(rendered.errorPolicyNormalized.retriable).toBe(true);
    expect(rendered.errorPolicyNormalized.hint).toBeTruthy();
  });
});

describe('baseline-independent actionability floors', () => {
  test('default snapshot exposes actionable refs with their labels', () => {
    const text = rendered.snapshot.text ?? '';
    expect(text).toContain('@e2 [text-field] "qa@example.com"');
    expect(text).toContain('@e3 [button] "Place order"');
    const nodes = (rendered.snapshot.jsonData as { nodes?: { ref?: string; label?: string }[] })
      .nodes;
    expect(nodes?.find((node) => node.ref === 'e3')).toMatchObject({ label: 'Place order' });
  });

  test('default settle output surfaces the newly added targets', () => {
    const text = rendered.samples['settle.default.text'];
    const settleText = 'text' in text ? text.text : '';
    expect(settleText).toContain('@e4');
    expect(settleText).toContain('@e5');
    expect(settleText).toContain('Order confirmed');
  });

  test('screenshot digest keeps overlay refs and the artifact retrieval handle', () => {
    expect(rendered.screenshotDigest).toMatchObject({
      overlayRefs: [
        { ref: 'e2', label: 'Email' },
        { ref: 'e3', label: 'Place order' },
      ],
      artifacts: [{ artifactType: 'screenshot', artifactId: 'artifact-economy-fixture' }],
    });
  });

  test('non-settled output carries the actual recovery guidance, not just a hint count', () => {
    const sample = rendered.samples['not-settled.default.text'];
    const text = 'text' in sample ? sample.text : '';
    expect(text).toContain('not settled after 3000ms');
    expect(text).toContain('wait stable');
    expect(text).toContain('snapshot -i');
  });

  test('MCP snapshot measures optimized text and structured content together', () => {
    expect(rendered.mcpSnapshot).toMatchObject({
      isError: false,
      structuredContent: {
        refsGeneration: 12,
        nodes: expect.arrayContaining([
          expect.objectContaining({ ref: 'e3', label: 'Place order' }),
        ]),
      },
      content: [
        {
          type: 'text',
          text: expect.stringContaining('@e3 [button] "Place order"'),
        },
      ],
    });
  });
});
