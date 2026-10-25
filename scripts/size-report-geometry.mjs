import fs from 'node:fs';
import path from 'node:path';

/**
 * The packaged runner's mirror of the shared foreground-geometry header. The packaged runner
 * includes the header through `../../../snapshot-bridge/ForegroundApplicationGeometry.h`, which
 * resolves into this directory from `dist/apple/runner/`.
 */
const PACKAGED_RUNNER_SHARED_HEADER_PATH =
  'dist/apple/snapshot-bridge/ForegroundApplicationGeometry.h';

const PACKAGED_RUNNER_ROOT_PATH = 'dist/apple/runner';

// Any quoted include whose final path segment is the shared header, such as
// `#import "../../../snapshot-bridge/ForegroundApplicationGeometry.h"`.
const SHARED_HEADER_INCLUDE = /"[^"\n]*ForegroundApplicationGeometry\.h"/;

/**
 * True when the packaged runner sources under `root` include the shared header. The mirror
 * requirement is derived from the runner's own sources, so a pack of a tree whose runner never
 * included the header still validates, and a runner that includes it cannot ship without it.
 */
function packagedRunnerIncludesSharedHeader(root) {
  const runnerRoot = path.join(root, PACKAGED_RUNNER_ROOT_PATH);
  if (!fs.existsSync(runnerRoot)) return false;
  return fs
    .readdirSync(runnerRoot, { recursive: true, encoding: 'utf8' })
    .some(
      (entry) =>
        typeof entry === 'string' &&
        /\.(?:m|h)$/.test(entry) &&
        SHARED_HEADER_INCLUDE.test(fs.readFileSync(path.join(runnerRoot, entry), 'utf8')),
    );
}

/**
 * Throws when the packaged runner under `root` includes the shared header and the package does not
 * carry the mirror. `shippedPaths` is the npm-pack entry list; omit it to probe the filesystem of a
 * clean-installed tree instead.
 */
export function assertPackagedRunnerSharedHeaderMirror(root, shippedPaths) {
  if (!packagedRunnerIncludesSharedHeader(root)) return;
  const shipped = shippedPaths
    ? shippedPaths.includes(PACKAGED_RUNNER_SHARED_HEADER_PATH)
    : fs.existsSync(path.join(root, PACKAGED_RUNNER_SHARED_HEADER_PATH));
  if (!shipped) {
    throw new Error(
      `Packaged runner includes the shared foreground geometry header but the package is missing: ${PACKAGED_RUNNER_SHARED_HEADER_PATH}`,
    );
  }
}
