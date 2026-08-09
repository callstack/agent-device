import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { PlatformPackageDeclaration } from './platform-package-policy.ts';

function gitLines(repoRoot: string, args: readonly string[]): string[] {
  return execFileSync('git', [...args], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function isProductionTypeScript(file: string): boolean {
  return file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.includes('/__tests__/');
}

export function listUntrackedProductionTypeScriptFiles(repoRoot: string): string[] {
  return gitLines(repoRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    'src/*.ts',
    'src/**/*.ts',
    'packages/*/src/*.ts',
    'packages/*/src/**/*.ts',
  ]).filter(isProductionTypeScript);
}

export function readTrackedPlatformPackageDeclarations(
  repoRoot: string,
): PlatformPackageDeclaration[] {
  return gitLines(repoRoot, ['ls-files', 'packages/platform-*/package.json']).map((file) => {
    const dir = path.posix.dirname(file);
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8')) as {
      name?: string;
      private?: boolean;
      exports?: Record<string, unknown>;
    };
    const family = path.posix.basename(dir).slice('platform-'.length);
    return {
      dir,
      family,
      name: manifest.name ?? '',
      private: manifest.private === true,
      exportedSubpaths: Object.keys(manifest.exports ?? {}).map((subpath) =>
        path.posix.join(manifest.name ?? '', subpath),
      ),
    };
  });
}
