/**
 * The rule that keeps test code out of the npm package, in one owner so the publishing gate
 * (`scripts/check-package.ts`, over the tree npm installs) and any later packager-side guard ask
 * the same question the same way.
 *
 * The package ships build input, not just binaries: `dist/apple/runner/**` is the Xcode project a
 * user's `xcodebuild` compiles, so the runner's test tree reaches the tarball as source. The
 * packager already removes the test sources it knows about — the `UnitTests/` directory, the
 * `#if AGENT_DEVICE_RUNNER_UNIT_TESTS` blocks, and the host app's fixture file — and nothing
 * re-checked the result, which is how 55 KB of `--agent-device-*` fixture screens stayed in the
 * published host app. These predicates are that re-check: a path list and file contents go in,
 * human-readable violations come out.
 */

/** Test-only directory names. Any packed path carrying one of these segments is test code. */
const TEST_ONLY_DIRECTORY_NAMES = new Set(['UnitTests', 'Tests', '__tests__', 'fixtures', 'mocks']);

/** A file name is test-only when its first dot starts `.test.` / `.spec.`, or it opts in by suffix. */
const TEST_ONLY_FILE_PATTERN = /(^|[._])(test|spec)\.[^./]+$/;
const TEST_ONLY_FILE_SUFFIX = 'ForTesting';

/**
 * The two SPM test-target stubs `package.json` `files` ships on purpose: SwiftPM refuses to
 * resolve a package whose declared test target has no source, and `swift build` in the published
 * tree must resolve it. They are the only paths under a `Tests/` directory the package may carry.
 */
export const DOCUMENTED_PACK_STUBS: ReadonlySet<string> = new Set([
  'apple/macos-helper/Tests/AgentDeviceMacOSHelperTests/PackStub.swift',
  'apple/macos-helper/Tests/AgentDeviceMacOSInputTests/PackStub.swift',
]);

/** Packaged-source locations scanned for test code that survived stripping, by path segments. */
const RUNNER_SOURCE_ROOT = ['dist', 'apple', 'runner'];
const RUNNER_HOST_APP_TARGET = [
  'dist',
  'apple',
  'runner',
  'AgentDeviceRunner',
  'AgentDeviceRunner',
];

const UNIT_TEST_CONDITION = 'AGENT_DEVICE_RUNNER_UNIT_TESTS';
/**
 * The host app's fixture screens switch on these launch arguments; the shipped host must not carry
 * one. Owned here for the published package; scripts/package-apple-runner-source.mjs keeps the
 * matching copy for the pre-pack check, and the two are kept identical on purpose.
 */
const FIXTURE_LAUNCH_ARGUMENT = /"--agent-device-[^"]*"/;

/** One packed file: the `package.json`-relative path and the bytes the tarball carries. */
export type PackedFile = {
  readonly path: string;
  readonly contents: string;
};

function segments(packedPath: string): string[] {
  return packedPath.split('/');
}

function hasTestOnlyDirectory(packedPath: string): string | undefined {
  return segments(packedPath).find((segment) => TEST_ONLY_DIRECTORY_NAMES.has(segment));
}

/** A file whose own name marks it as test code: `foo.test.ts`, `bar.spec.mjs`, `BazForTesting.swift`. */
function isTestOnlyFileName(fileName: string): boolean {
  return TEST_ONLY_FILE_PATTERN.test(fileName) || fileName.includes(TEST_ONLY_FILE_SUFFIX);
}

/**
 * Every packed path that names test code, as `path: reason` lines. The documented PackStubs are
 * the single exemption; they are listed rather than patterned so a new stub has to be declared.
 */
export function testOnlyPathFailures(packedPaths: Iterable<string>): string[] {
  const failures: string[] = [];
  for (const packedPath of packedPaths) {
    if (DOCUMENTED_PACK_STUBS.has(packedPath)) {
      continue;
    }
    const directory = hasTestOnlyDirectory(packedPath);
    if (directory !== undefined) {
      failures.push(`${packedPath}: test-only directory "${directory}/" ships in the package.`);
      continue;
    }
    const fileName = segments(packedPath).at(-1) ?? packedPath;
    if (isTestOnlyFileName(fileName)) {
      failures.push(`${packedPath}: test-only file name ships in the package.`);
    }
  }
  return failures;
}

function isUnderRunnerSource(packedPath: string): boolean {
  const parts = segments(packedPath);
  return RUNNER_SOURCE_ROOT.every((segment, index) => parts[index] === segment);
}

function isRunnerHostAppSource(packedPath: string): boolean {
  const parts = segments(packedPath);
  return RUNNER_HOST_APP_TARGET.every((segment, index) => parts[index] === segment);
}

/**
 * Test code that survived the packager's stripping, as `path: reason` lines. Content is read only
 * for the packaged runner source: the product bundle legitimately names the unit-test flag while
 * it constructs the build recipe, so a package-wide token scan would fail on its own daemon.
 */
export function testOnlyContentFailures(files: Iterable<PackedFile>): string[] {
  const failures: string[] = [];
  for (const file of files) {
    if (!isUnderRunnerSource(file.path)) {
      continue;
    }
    if (file.contents.includes(`#if ${UNIT_TEST_CONDITION}`)) {
      failures.push(
        `${file.path}: a #if ${UNIT_TEST_CONDITION} block survived packaging; the packager strips unit-test source.`,
      );
    }
    if (isRunnerHostAppSource(file.path) && FIXTURE_LAUNCH_ARGUMENT.test(file.contents)) {
      failures.push(
        `${file.path}: the packaged host app carries a --agent-device-* fixture launch argument. ` +
          'Fixture screens belong in the unit-test fixture source the packager drops.',
      );
    }
  }
  return failures;
}
