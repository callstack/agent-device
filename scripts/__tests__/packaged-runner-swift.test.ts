import assert from 'node:assert/strict';
import { test } from 'vitest';
import { declarationsByLine, parityFailures } from '../check-packaged-runner-swift.ts';

function swift(...lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

const source = swift(
  '// a design note',
  'extension RunnerTests {',
  '  /// What this does.',
  '  func helper() -> Int { 1 }',
  '}',
);

test('a packaged file that emptied its comment lines reports no failure', () => {
  const packaged = swift('', 'extension RunnerTests {', '', '  func helper() -> Int { 1 }', '}');

  assert.deepEqual(parityFailures('Fixture.swift', source, packaged), []);
});

test('a deleted comment line is named as a line-count failure', () => {
  const packaged = swift('extension RunnerTests {', '  func helper() -> Int { 1 }', '}');

  const failures = parityFailures('Fixture.swift', source, packaged);
  assert.equal(failures.length, 1);
  assert.match(failures[0] ?? '', /Fixture\.swift: packaged source has 4 lines, checkout has 6\./);
  assert.match(failures[0] ?? '', /empty a removed line, not delete it/);
});

// The line count alone cannot see a rewrite that moves a declaration and pads elsewhere, which is
// the failure an `xcodebuild` line number would land on.
test('a declaration that moved while the line count held is named with its line', () => {
  const packaged = swift('', 'extension RunnerTests {', '  func helper() -> Int { 1 }', '', '}');

  const failures = parityFailures('Fixture.swift', source, packaged);
  assert.equal(failures.length, 1);
  assert.match(failures[0] ?? '', /Fixture\.swift:3: packaged `func helper`/);
  assert.match(failures[0] ?? '', /is `\(blank\)` at the same line of the checkout/);
});

test('declarations are keyed by their one-based line', () => {
  assert.deepEqual(
    [
      ...declarationsByLine(
        swift('import XCTest', 'final class RunnerTests: XCTestCase {', '  func testCommand() {}'),
      ),
    ],
    [
      [2, 'class RunnerTests'],
      [3, 'func testCommand'],
    ],
  );
});
