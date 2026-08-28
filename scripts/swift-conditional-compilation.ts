// Evaluating Swift's `#if` for one platform — the question "does this source line compile for
// iOS / macOS / tvOS?", kept apart from `check-xctest-selection.ts`, which answers the different
// question of which CI lane reaches which test.
//
// This is deliberately NOT a Swift parser reconstructing the compiler. It understands exactly
// the directive vocabulary the runner sources use and THROWS on anything else, so a new guard
// shape fails the gate loudly instead of being silently mis-bucketed. The gate's callers back
// it with an executed-count assertion, so a wrong answer here cannot pass as a smaller green.

/** The platforms a lane can build the bundle for. visionOS builds exist but no lane runs tests on one. */
export type Platform = 'iOS' | 'macOS' | 'tvOS';

export const PLATFORMS: readonly Platform[] = ['iOS', 'macOS', 'tvOS'];

// Swift conditional-compilation directives, at any indentation. A `//` comment cannot start
// with `#`, so prose about a guard never reads as one.
const DIRECTIVE = /^\s*#(if|elseif|else|endif)\b(.*)$/;

/** A `#if` condition outside the vocabulary below. Thrown, never guessed at. */
export class UnsupportedConditionError extends Error {}

function tokenize(condition: string): string[] {
  const tokens: string[] = [];
  const pattern = /\s*(&&|\|\||!|\(|\)|[A-Za-z_][\w.]*)/y;
  let index = 0;
  while (index < condition.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(condition);
    if (!match) throw new UnsupportedConditionError(`cannot read #if condition: ${condition}`);
    tokens.push(match[1] as string);
    index = pattern.lastIndex;
    if (index === condition.length || /^\s*$/.test(condition.slice(index))) break;
  }
  return tokens;
}

/**
 * Truth of one `#if` condition when compiling the unit-test variant for `platform`. The
 * vocabulary is exactly what the runner sources use; anything else throws rather than
 * guessing, because a guess in either direction makes this check see a test on a platform
 * that never compiles it, or miss one that does.
 */
export function evaluateCondition(condition: string, platform: Platform): boolean {
  const tokens = tokenize(condition.replace(/\/\/.*$/, '').trim());
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];
  const fail = (reason: string): never => {
    throw new UnsupportedConditionError(`${reason} in #if condition: ${condition.trim()}`);
  };
  const expectToken = (expected: string) => {
    if (take() !== expected) fail(`expected ${expected}`);
  };
  const call = (name: string, argument: string): boolean => {
    if (name === 'os') return argument === platform;
    if (name === 'canImport' && argument === 'UIKit') return platform !== 'macOS';
    if (name === 'canImport' && argument === 'AppKit') return platform === 'macOS';
    // Every lane that runs tests builds for a simulator; the physical-device build is the
    // daemon's, not a test lane's.
    if (name === 'targetEnvironment' && argument === 'simulator') return platform !== 'macOS';
    return fail(`unsupported ${name}(${argument})`);
  };
  const primary = (): boolean => {
    const token = take();
    if (token === undefined) return fail('truncated expression');
    if (token === '(') {
      const value = or();
      expectToken(')');
      return value;
    }
    if (peek() === '(') {
      take();
      const argument = take();
      if (argument === undefined) return fail('truncated expression');
      expectToken(')');
      return call(token, argument);
    }
    // Both are defined by every unit-test build: the compile flag by the build script, and
    // DEBUG by the Debug configuration every lane builds.
    if (token === 'AGENT_DEVICE_RUNNER_UNIT_TESTS' || token === 'DEBUG') return true;
    return fail(`unsupported ${token}`);
  };
  const unary = (): boolean => (peek() === '!' ? (take(), !unary()) : primary());
  const and = (): boolean => {
    let value = unary();
    while (peek() === '&&') {
      take();
      value = unary() && value;
    }
    return value;
  };
  const or = (): boolean => {
    let value = and();
    while (peek() === '||') {
      take();
      value = and() || value;
    }
    return value;
  };
  const value = or();
  if (position !== tokens.length) fail('trailing tokens');
  return value;
}

type ConditionalFrame = { parentActive: boolean; active: boolean; taken: boolean };

/** One directive's effect on the frame stack; the frames' `active` flags decide what compiles. */
function applyDirective(
  frames: ConditionalFrame[],
  keyword: string,
  condition: string,
  platform: Platform,
): void {
  const parentActive = () => frames.every((frame) => frame.active);
  if (keyword === 'if') {
    const outer = parentActive();
    const taken = evaluateCondition(condition, platform);
    frames.push({ parentActive: outer, active: outer && taken, taken });
    return;
  }
  const frame = frames.at(-1);
  if (!frame) throw new UnsupportedConditionError(`#${keyword} without a matching #if`);
  if (keyword === 'endif') {
    frames.pop();
    return;
  }
  const taken = !frame.taken && (keyword === 'else' || evaluateCondition(condition, platform));
  frame.active = frame.parentActive && taken;
  frame.taken ||= taken;
}

/**
 * The source with every line inside an inactive `#if` branch (and every directive line)
 * blanked, so the declaration scan sees what the compiler sees for `platform`.
 */
export function activeSource(text: string, platform: Platform, file = '<swift source>'): string {
  const frames: ConditionalFrame[] = [];
  return text
    .split('\n')
    .map((line, index) => {
      const directive = DIRECTIVE.exec(line);
      if (!directive) return frames.every((frame) => frame.active) ? line : '';
      try {
        applyDirective(frames, directive[1] as string, directive[2] ?? '', platform);
      } catch (error) {
        if (!(error instanceof UnsupportedConditionError)) throw error;
        throw new UnsupportedConditionError(`${file}:${index + 1}: ${error.message}`);
      }
      return '';
    })
    .join('\n');
}
