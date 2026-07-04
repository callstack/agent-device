import { describe, expect, test } from 'vitest';
import { interactionCliOutputFormatters } from './output.ts';

const formatFind = (result: Record<string, unknown>) =>
  interactionCliOutputFormatters.find({ input: {}, result });

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
