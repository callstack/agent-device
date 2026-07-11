import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runCmdSync } from '../../src/utils/exec.ts';
import { COMMAND_OWNER_FILES } from '../../src/core/command-descriptor/owner-files.ts';
import { getDaemonRouteOwnerFiles } from '../../src/daemon/route-owner-files.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const distPath = path.join(repoRoot, 'dist/src');

function collectJsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' });
  return entries.filter((name) => name.endsWith('.js')).map((name) => path.join(dir, name));
}

describe('owner-file metadata', () => {
  test('does not leak into production bundles after a clean build', { timeout: 30_000 }, () => {
    fs.rmSync(path.join(repoRoot, 'dist'), { recursive: true, force: true });

    const build = runCmdSync(
      'node',
      [
        '--experimental-strip-types',
        'node_modules/tsdown/dist/run.mjs',
        '--config-loader',
        'native',
      ],
      { cwd: repoRoot },
    );
    expect(build.exitCode, build.stderr).toBe(0);

    expect(
      fs.existsSync(path.join(distPath, 'sdk-selectors.js')),
      'selector runtime should keep the stable sdk-selectors.js chunk',
    ).toBe(true);
    expect(
      fs.existsSync(path.join(distPath, 'selectors2.js')),
      'selector runtime should not fall back to an auto-numbered chunk',
    ).toBe(false);

    const jsFiles = collectJsFiles(distPath);
    const bundle = jsFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

    const forbiddenMetadata = [
      'ownerFiles',
      ...Object.values(COMMAND_OWNER_FILES).flat(),
      ...Object.values(getDaemonRouteOwnerFiles()),
    ];

    for (const value of forbiddenMetadata) {
      expect(
        bundle.includes(value),
        `owner-file metadata ${value} leaked into production bundle`,
      ).toBe(false);
    }
  });
});
