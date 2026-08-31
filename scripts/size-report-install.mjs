import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    return measureDirectory(packageDir);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
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
