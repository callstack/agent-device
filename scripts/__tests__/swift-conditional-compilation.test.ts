// The `#if` evaluator decides which platform compiles which test, so a wrong answer here
// re-buckets a test silently — which is why it refuses vocabulary it does not know instead of
// guessing, and why that refusal is asserted below alongside the precedence and nesting cases.

import { describe, expect, test } from 'vitest';
import {
  activeSource,
  evaluateCondition,
  PLATFORMS,
  UnsupportedConditionError,
  type Platform,
} from '../swift-conditional-compilation.ts';

describe('the #if evaluator', () => {
  test.each([
    ['AGENT_DEVICE_RUNNER_UNIT_TESTS', { iOS: true, macOS: true, tvOS: true }],
    ['os(iOS)', { iOS: true, macOS: false, tvOS: false }],
    ['!os(macOS)', { iOS: true, macOS: false, tvOS: true }],
    ['AGENT_DEVICE_RUNNER_UNIT_TESTS && os(iOS)', { iOS: true, macOS: false, tvOS: false }],
    ['os(tvOS) || os(macOS)', { iOS: false, macOS: true, tvOS: true }],
    ['os(macOS) || os(tvOS) || os(visionOS)', { iOS: false, macOS: true, tvOS: true }],
    ['canImport(UIKit)', { iOS: true, macOS: false, tvOS: true }],
    ['canImport(AppKit)', { iOS: false, macOS: true, tvOS: false }],
    ['os(iOS) && targetEnvironment(simulator)', { iOS: true, macOS: false, tvOS: false }],
    ['!(os(iOS) || os(tvOS)) // desktop', { iOS: false, macOS: true, tvOS: false }],
  ] as const)('%s', (condition, expected) => {
    for (const platform of PLATFORMS) {
      expect(evaluateCondition(condition, platform)).toBe(expected[platform]);
    }
  });

  test('refuses vocabulary it does not know rather than guessing', () => {
    for (const condition of ['swift(>=5.9)', 'canImport(SwiftUI)', 'RELEASE', 'os(iOS) &&']) {
      expect(() => evaluateCondition(condition, 'iOS')).toThrow(UnsupportedConditionError);
    }
    expect(() => activeSource('#if compiler(>=6)\nx\n#endif\n', 'iOS', 'F.swift')).toThrow(
      /F\.swift:1/,
    );
  });

  test('blanks inactive branches, follows #elseif/#else, and nests', () => {
    const text = [
      '#if os(iOS)',
      'ios',
      '#elseif os(tvOS)',
      'tv',
      '#else',
      'other',
      '  #if AGENT_DEVICE_RUNNER_UNIT_TESTS',
      '  nested',
      '  #endif',
      '#endif',
      'always',
    ].join('\n');
    const kept = (platform: Platform) =>
      activeSource(text, platform)
        .split('\n')
        .filter((line) => line.trim() !== '');
    expect(kept('iOS')).toEqual(['ios', 'always']);
    expect(kept('tvOS')).toEqual(['tv', 'always']);
    expect(kept('macOS')).toEqual(['other', '  nested', 'always']);
  });

  test('a nested #if under an inactive branch stays inactive whatever it says', () => {
    const text = '#if os(iOS)\n#if os(macOS) || !os(macOS)\ninner\n#endif\n#endif\n';
    expect(activeSource(text, 'macOS').trim()).toBe('');
    expect(activeSource(text, 'iOS').trim()).toBe('inner');
  });
});
