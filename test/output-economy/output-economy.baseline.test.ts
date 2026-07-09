import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { measureEconomySample, type EconomyMetrics } from './economy-metrics.ts';
import { renderOutputFixtures } from './render-fixtures.ts';

const baselineUrl = new URL('./output-economy.baseline.json', import.meta.url);
const rendered = renderOutputFixtures();
const actual = Object.fromEntries(
  Object.entries(rendered.samples).map(([name, sample]) => [name, measureEconomySample(sample)]),
) as Record<string, EconomyMetrics>;

if (process.env.UPDATE_OUTPUT_ECONOMY_BASELINE === '1') {
  fs.writeFileSync(baselineUrl, `${JSON.stringify(actual, null, 2)}\n`);
}

const baseline = JSON.parse(fs.readFileSync(baselineUrl, 'utf8')) as Record<string, EconomyMetrics>;

describe('deterministic output-economy baseline', () => {
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
});
