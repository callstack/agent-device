import { describe, expect, test } from 'vitest';
import { interactionCliOutputFormatters } from './output.ts';

const formatFind = (result: Record<string, unknown>) =>
  interactionCliOutputFormatters.find({ input: {}, result });

const formatPress = (result: Record<string, unknown>) =>
  interactionCliOutputFormatters.press({ input: {}, result });

const formatFill = (result: Record<string, unknown>) =>
  interactionCliOutputFormatters.fill({ input: {}, result });

const formatLongPress = (result: Record<string, unknown>) =>
  interactionCliOutputFormatters.longpress({ input: {}, result });

describe('find CLI output', () => {
  test('click prints the same success line as a direct press', () => {
    const output = formatFind({
      ref: '@e2',
      locator: 'any',
      query: 'Catalog',
      x: 100,
      y: 50,
      message: 'Tapped @e2 (100, 50)',
    });
    expect(output.text).toBe('Tapped @e2 (100, 50)');
  });

  test('fill prefers the success message over the raw filled text', () => {
    const output = formatFind({
      x: 100,
      y: 50,
      text: 'qa@example.com',
      message: 'Filled 14 chars',
    });
    expect(output.text).toBe('Filled 14 chars');
  });

  test('focus prints the delegated focus confirmation', () => {
    const output = formatFind({ x: 100, y: 50, message: 'Focused (100, 50)' });
    expect(output.text).toBe('Focused (100, 50)');
  });

  test('get text still prints the extracted text', () => {
    const output = formatFind({ ref: '@e2', text: 'Catalog' });
    expect(output.text).toBe('Catalog');
  });

  test('exists still prints the found flag', () => {
    const output = formatFind({ found: true });
    expect(output.text).toBe('Found: true');
  });
});

describe('press CLI output', () => {
  test('appends settle verdict and diff lines for selector/coordinate tap messages', () => {
    const output = formatPress({
      message: 'Tapped (278, 817)',
      x: 278,
      y: 817,
      settle: {
        settled: true,
        waitedMs: 1200,
        diff: {
          summary: { additions: 1, removals: 1, unchanged: 8 },
          lines: [
            { kind: 'removed', text: '@e4 [button] "Search"' },
            { kind: 'added', text: '@e9 [text] "Notifications"' },
          ],
        },
      },
    });

    expect(output.text).toBe(
      [
        'Tapped (278, 817)',
        'settled after 1200ms: +1 -1 (~8 unchanged)',
        '- @e4 [button] "Search"',
        '+ @e9 [text] "Notifications"',
      ].join('\n'),
    );
  });

  test('prints not-settled verdict without a dangling diff summary', () => {
    const output = formatPress({
      message: 'Tapped (278, 817)',
      x: 278,
      y: 817,
      settle: {
        settled: false,
        waitedMs: 10000,
        hint: 'The UI kept changing for the whole settle budget, so no settled diff is shown. Take a fresh snapshot.',
      },
    });

    expect(output.text).toBe(
      [
        'Tapped (278, 817)',
        'not settled after 10000ms',
        'hint: The UI kept changing for the whole settle budget, so no settled diff is shown. Take a fresh snapshot.',
      ].join('\n'),
    );
  });
});

describe('fill CLI output', () => {
  test('prints the fill success message without settle details by default', () => {
    const output = formatFill({
      text: 'alpenglow',
      message: 'Filled 9 chars',
    });

    expect(output.text).toBe('Filled 9 chars');
  });

  test('appends settle verdict and diff lines when present', () => {
    const output = formatFill({
      text: 'alpenglow',
      message: 'Filled 9 chars',
      settle: {
        settled: true,
        waitedMs: 750,
        diff: {
          summary: { additions: 2, removals: 1, unchanged: 4 },
          lines: [
            { kind: 'removed', text: '@e4 [text-field] "Search"' },
            { kind: 'added', text: '@e23 [text-field] "alpenglow"' },
            { kind: 'added', text: '@e31 [static-text] "Alpenglow"' },
          ],
        },
      },
    });

    expect(output.text).toBe(
      [
        'Filled 9 chars',
        'settled after 750ms: +2 -1 (~4 unchanged)',
        '- @e4 [text-field] "Search"',
        '+ @e23 [text-field] "alpenglow"',
        '+ @e31 [static-text] "Alpenglow"',
      ].join('\n'),
    );
  });
});

describe('longpress CLI output', () => {
  test('appends settle verdict and diff lines when present', () => {
    const output = formatLongPress({
      message: 'Long pressed (60, 40)',
      settle: {
        settled: true,
        waitedMs: 600,
        diff: {
          summary: { additions: 1, removals: 0, unchanged: 6 },
          lines: [{ kind: 'added', text: '@e12 [button] "Copy"' }],
        },
      },
    });

    expect(output.text).toBe(
      [
        'Long pressed (60, 40)',
        'settled after 600ms: +1 -0 (~6 unchanged)',
        '+ @e12 [button] "Copy"',
      ].join('\n'),
    );
  });
});
