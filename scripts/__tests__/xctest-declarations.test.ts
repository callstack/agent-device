// The declaration scan decides what "declared" means — which `func test…` is addressable as
// `Target/Class/method`, and for which platforms — so both halves are proven here: the shapes
// no filter could address, and the per-platform attribution that turns a `#if` guard into a
// lane classification.

import { describe, expect, test } from 'vitest';
import { parseDeclaredTests, parseDeclaredTestsByPlatform } from '../xctest-declarations.ts';

const TARGET = 'AgentDeviceRunnerUITests';

function source(text: string) {
  return [{ file: 'RunnerTests+Fixture.swift', text }];
}

describe('the declaration scan', () => {
  test('binds a method to the top-level type that encloses it', () => {
    expect(
      parseDeclaredTests(
        TARGET,
        source(
          'final class RunnerTests: XCTestCase {\n  func testInClass() {}\n}\n\n' +
            'extension RunnerTests {\n  func testInExtension() throws {}\n}\n\n' +
            'final class OtherTests: XCTestCase {\n  func testElsewhere() async throws {}\n}\n',
        ),
      ),
    ).toEqual([
      `${TARGET}/OtherTests/testElsewhere`,
      `${TARGET}/RunnerTests/testInClass`,
      `${TARGET}/RunnerTests/testInExtension`,
    ]);
  });

  test('ignores declarations no filter could address', () => {
    expect(
      parseDeclaredTests(
        TARGET,
        source(
          'extension RunnerTests {\n' +
            // A helper type declared inside a test body must not capture the methods after
            // it, and `class func` must not read as a type declaration named `func`.
            '  class func makeHelper() {}\n' +
            '  func testWithNestedHelper() {\n' +
            '    final class ResultBox {}\n' +
            '    func testLocal() {}\n' +
            '  }\n' +
            '  // func testCommentedOut() {}\n' +
            '  func testAfterNesting() {}\n' +
            '}\n',
        ),
      ),
    ).toEqual([
      `${TARGET}/RunnerTests/testAfterNesting`,
      `${TARGET}/RunnerTests/testWithNestedHelper`,
    ]);
  });

  test('reads a file whose name does not start with RunnerTests', () => {
    // RunnerTapPointPolicy.swift is the real instance: the synchronized-root-group project
    // compiles every .swift in the directory, so file naming carries no membership meaning.
    expect(
      parseDeclaredTests(TARGET, [
        {
          file: 'RunnerTapPointPolicy.swift',
          text: 'extension RunnerTests {\n  func testGolden() {}\n}\n',
        },
      ]),
    ).toEqual([`${TARGET}/RunnerTests/testGolden`]);
  });

  test('attributes each declared method to the platforms that compile it', () => {
    expect(
      parseDeclaredTestsByPlatform(
        TARGET,
        source(
          'extension RunnerTests {\n#if AGENT_DEVICE_RUNNER_UNIT_TESTS\n  func testPure() {}\n' +
            '#if os(iOS)\n  func testSim() {}\n#endif\n#if os(tvOS) || os(macOS)\n' +
            '  func testNoSpringBoard() {}\n#endif\n#endif\n}\n',
        ),
      ),
    ).toEqual([
      { identifier: `${TARGET}/RunnerTests/testNoSpringBoard`, platforms: ['macOS', 'tvOS'] },
      { identifier: `${TARGET}/RunnerTests/testPure`, platforms: ['iOS', 'macOS', 'tvOS'] },
      { identifier: `${TARGET}/RunnerTests/testSim`, platforms: ['iOS'] },
    ]);
  });
});
