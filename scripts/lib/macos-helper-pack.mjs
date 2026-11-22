/**
 * What the `@agent-device/macos` package must pack for its Swift helper, in one owner.
 *
 * The package ships `macos-helper` as buildable source and builds it on the user's machine. Its
 * manifest declares the test targets, and SwiftPM refuses to load a package whose declared test
 * target has no sources. So `files` ships exactly one `PackStub.swift` per target and excludes
 * every other test source. Nothing else verifies the packed tree compiles before a user's first
 * macOS command, so these rules read the pack's own file list.
 */

/** Where the helper sits in the packed `@agent-device/macos` tree. */
export const MACOS_HELPER_PACK_ROOT = 'macos-helper';

/** The test targets the helper manifest declares: the one reading of which test targets exist. */
export function readMacosHelperTestTargets(manifestSource) {
  return [...manifestSource.matchAll(/\.testTarget\(\s*name:\s*"([^"]+)"/g)].map(
    (match) => match[1],
  );
}

/**
 * The helper's pack stubs: the only paths under its `Tests/` directory the package may carry. A new
 * target's stub must be declared here, in the failing direction.
 */
export const DOCUMENTED_PACK_STUBS = Object.freeze([
  `${MACOS_HELPER_PACK_ROOT}/Tests/AgentDeviceMacOSHelperTests/PackStub.swift`,
  `${MACOS_HELPER_PACK_ROOT}/Tests/AgentDeviceMacOSInputTests/PackStub.swift`,
]);

/** Every way the packed helper tree is not the buildable package it must be, one line each. */
export function macosHelperPackFailures(paths, manifestSource) {
  const failures = [];
  const testsRoot = `${MACOS_HELPER_PACK_ROOT}/Tests`;
  const manifestPath = `${MACOS_HELPER_PACK_ROOT}/Package.swift`;
  const documentedStubPaths = new Set(DOCUMENTED_PACK_STUBS);
  const shippedSwiftTests = paths.filter(
    (entryPath) =>
      (entryPath === testsRoot || entryPath.startsWith(`${testsRoot}/`)) &&
      !documentedStubPaths.has(entryPath),
  );
  if (shippedSwiftTests.length > 0) {
    failures.push(`npm pack includes macOS helper test sources: ${shippedSwiftTests.join(', ')}`);
  }
  const buildOutput = paths.filter((entryPath) => entryPath.includes('/.build/'));
  if (buildOutput.length > 0) {
    failures.push(`npm pack includes macOS helper build output: ${buildOutput.join(', ')}`);
  }
  // Sources without the manifest are not a buildable Swift package, and a package with no helper
  // at all cannot serve a macOS command.
  if (!paths.includes(manifestPath)) {
    failures.push('npm pack ships no macOS helper Package.swift');
    return failures;
  }
  if (!paths.some((entryPath) => entryPath.startsWith(`${MACOS_HELPER_PACK_ROOT}/Sources/`))) {
    failures.push('npm pack ships the macOS helper manifest without its sources');
  }
  const expectedStubs = new Set(
    readMacosHelperTestTargets(manifestSource).map(
      (target) => `${testsRoot}/${target}/PackStub.swift`,
    ),
  );
  const missingStubs = [...expectedStubs].filter((stubPath) => !paths.includes(stubPath));
  if (missingStubs.length > 0) {
    failures.push(
      `npm pack is missing macOS helper test-target pack stubs: ${missingStubs.join(', ')}`,
    );
  }
  // The other direction: a declared stub whose target left the manifest stays exempt from the path
  // rule above, so it is compared against the manifest set here.
  const staleStubs = [...documentedStubPaths].filter(
    (stubPath) => paths.includes(stubPath) && !expectedStubs.has(stubPath),
  );
  if (staleStubs.length > 0) {
    failures.push(
      `npm pack ships documented pack stubs no test target declares: ${staleStubs.join(', ')}`,
    );
  }
  return failures;
}
