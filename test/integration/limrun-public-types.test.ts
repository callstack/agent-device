import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCmdSync } from '../../src/utils/exec.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSC_BIN = path.join(repoRoot, 'node_modules/.bin/tsc');
const COMMAND_TIMEOUT_MS = 120_000;

function ensureBuiltPackage(): void {
  const declarationPath = path.join(repoRoot, 'dist', 'src', 'limrun.d.ts');
  if (fs.existsSync(declarationPath)) return;

  runCmdSync('pnpm', ['build'], {
    cwd: repoRoot,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
}

test('compiled Limrun subpath preserves root Android provider capabilities', () => {
  ensureBuiltPackage();

  // Keep the fixture under the package root so TypeScript resolves the
  // package self-reference through package.json's compiled `types` export.
  const tempRoot = fs.mkdtempSync(path.join(repoRoot, '.tmp-limrun-types-'));
  try {
    fs.writeFileSync(
      path.join(tempRoot, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            noEmit: true,
            strict: true,
            types: ['node'],
          },
          include: ['fixture.ts'],
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(tempRoot, 'fixture.ts'),
      `import type { LimrunAndroidDeviceSession } from 'agent-device/limrun';

declare const session: LimrunAndroidDeviceSession;
void session.adb.spawn;
void session.adb.pull;
void session.adb.install;
void session.adb.touch;
void session.adb.gestureViewport;
`,
    );

    const result = runCmdSync(
      TSC_BIN,
      ['--noEmit', '-p', path.join(tempRoot, 'tsconfig.json'), '--pretty', 'false'],
      {
        cwd: tempRoot,
        timeoutMs: COMMAND_TIMEOUT_MS,
        allowFailure: true,
      },
    );

    assert.equal(
      result.exitCode,
      0,
      `The compiled agent-device/limrun declarations no longer preserve the root Android provider contract:\n${result.stdout}${result.stderr}`,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
