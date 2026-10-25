import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSnapshotBridgeAssets, SNAPSHOT_BRIDGE_ASSET_PATHS } from './size-report-package.mjs';

// The mirror path the packaged runner's relative include resolves to. Declared here rather than
// imported: `.github/workflows/size.yml` mixes one commit's copy of each script, so an import of a
// sibling's newer export would break the base measurement. The value is pinned by tests on both
// consumers.
const PACKAGED_RUNNER_SHARED_HEADER_PATH =
  'dist/apple/snapshot-bridge/ForegroundApplicationGeometry.h';

export function measureCleanInstalledPackage(tarballPath, packageName) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-size-install-'));
  const consumerDir = path.join(workDir, 'consumer');
  const npmCache = path.join(workDir, 'npm-cache');
  fs.mkdirSync(consumerDir);
  fs.mkdirSync(npmCache);
  try {
    execFileSync(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        '--prefix',
        consumerDir,
        tarballPath,
      ],
      {
        cwd: consumerDir,
        env: { ...process.env, npm_config_cache: npmCache },
        stdio: ['ignore', 'ignore', 'inherit'],
        timeout: 5 * 60 * 1000,
      },
    );
    const packageDir = path.join(consumerDir, 'node_modules', packageName);
    if (!fs.existsSync(packageDir)) {
      throw new Error(`Clean install did not create node_modules/${packageName}.`);
    }
    assertInstalledSnapshotBridge(packageDir);
    return {
      ...measureDirectory(packageDir),
      totalBytes: measureDirectory(path.join(consumerDir, 'node_modules')).packageBytes,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export function assertInstalledSnapshotBridge(packageDir) {
  const bridgeRoot = path.join(packageDir, 'apple', 'snapshot-bridge');
  if (!fs.existsSync(bridgeRoot)) return;
  const present = SNAPSHOT_BRIDGE_ASSET_PATHS.filter((assetPath) =>
    fs.existsSync(path.join(packageDir, assetPath)),
  );
  assertSnapshotBridgeAssets(present, 'Clean-installed snapshot bridge');
  // The runner source and its shared-header mirror are packaged as a pair; require the mirror
  // exactly when the installed tree carries the packaged runner.
  if (
    fs.existsSync(path.join(packageDir, 'dist', 'apple', 'runner')) &&
    !fs.existsSync(path.join(packageDir, PACKAGED_RUNNER_SHARED_HEADER_PATH))
  ) {
    throw new Error(
      `Clean-installed package ships the packaged runner but is missing: ${PACKAGED_RUNNER_SHARED_HEADER_PATH}`,
    );
  }
}

export function measureDirectory(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.reduce(
    (total, entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        const nested = measureDirectory(entryPath);
        return {
          packageBytes: total.packageBytes + nested.packageBytes,
          files: total.files + nested.files,
        };
      }
      if (entry.isSymbolicLink()) {
        return {
          packageBytes: total.packageBytes + Buffer.byteLength(fs.readlinkSync(entryPath)),
          files: total.files + 1,
        };
      }
      const stat = fs.statSync(entryPath);
      return {
        packageBytes: total.packageBytes + stat.size,
        files: total.files + 1,
      };
    },
    { packageBytes: 0, files: 0 },
  );
}
