import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

// `.github/actions/setup-android-sdk` owns the pinned build-tools version and the sdkmanager
// install. The version decides the helper APK bytes, so a second copy can drift silently.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OWNER_DIR = path.join('.github', 'actions', 'setup-android-sdk');
const SCANNED_ROOTS = ['.github', 'scripts'];
const OWNED_PATTERNS = [/\b36\.0\.0\b/, /sdkmanager/];

function listFiles(relativeDir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(REPO_ROOT, relativeDir), { withFileTypes: true })) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) listFiles(relativePath, files);
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

test('only setup-android-sdk names the build-tools version or runs sdkmanager', () => {
  const offenders = SCANNED_ROOTS.flatMap((root) => listFiles(root))
    .filter((file) => !file.startsWith(`${OWNER_DIR}${path.sep}`))
    .flatMap((file) => {
      const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      return OWNED_PATTERNS.filter((pattern) => pattern.test(source)).map(
        (pattern) => `${file} matches ${pattern}`,
      );
    });
  assert.deepEqual(offenders, [], 'call ./.github/actions/setup-android-sdk instead');
});

test('setup-android-sdk lets a real licence failure stop the step', () => {
  const action = fs.readFileSync(path.join(REPO_ROOT, OWNER_DIR, 'action.yml'), 'utf8');
  assert.match(action, /set \+o pipefail\n\s*yes \| "\$SDKMANAGER" --licenses >\/dev\/null\n/);
  assert.doesNotMatch(action, /--licenses[^\n]*\|\|/);
  assert.match(action, /AGENT_DEVICE_ANDROID_BUILD_TOOLS=\$BUILD_TOOLS_VERSION" >> "\$GITHUB_ENV"/);
});
