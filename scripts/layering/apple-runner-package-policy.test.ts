import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseImports } from './model.ts';
import {
  APPLE_RUNNER_DIR,
  appleRunnerEntryImporterViolations,
  appleRunnerPackageSiteViolations,
} from './apple-runner-package-policy.ts';

function packageViolations(file: string, source: string): string[] {
  return parseImports(source).flatMap((site) =>
    appleRunnerPackageSiteViolations(file, site).map((violation) => violation.message),
  );
}

function importerViolations(file: string, source: string): string[] {
  return parseImports(source).flatMap((site) =>
    appleRunnerEntryImporterViolations(file, site).map((violation) => violation.message),
  );
}

const RUNNER_FILE = `${APPLE_RUNNER_DIR}src/runner-session.ts`;

test('the runner package may import the vocabulary and substrate packages a platform family may', () => {
  for (const spec of [
    '@agent-device/contracts/touch-runtime',
    '@agent-device/capture-kit/ios-snapshot-engine',
    '@agent-device/host-kit/command',
    '@agent-device/kernel/errors',
    '@agent-device/provision-kit/boot-diagnostics',
    '@agent-device/xml',
  ]) {
    assert.deepEqual(packageViolations(RUNNER_FILE, `import { x } from '${spec}';`), [], spec);
  }
});

test('the runner package never imports platform-apple, a sibling platform, or the daemon', () => {
  for (const spec of [
    '@agent-device/platform-apple',
    '@agent-device/platform-apple/runner/operations',
    '@agent-device/platform-android/mechanics',
    '@agent-device/daemon',
    '@agent-device/apple-runner',
  ]) {
    assert.match(
      packageViolations(RUNNER_FILE, `import { x } from '${spec}';`).join('\n'),
      /apple-runner may import workspace code only from/,
      spec,
    );
  }
});

test('the runner package may not reach platform-apple, root, or daemon code by path', () => {
  for (const spec of [
    '../../platform-apple/src/core/simctl.ts',
    '../../../src/cli.ts',
    'agent-device/io',
  ]) {
    assert.match(
      packageViolations(RUNNER_FILE, `import { x } from '${spec}';`).join('\n'),
      /may not reach platform-apple, root, or daemon code/,
      spec,
    );
  }
  assert.deepEqual(packageViolations(RUNNER_FILE, "import { x } from './host.ts';"), []);
  assert.deepEqual(
    packageViolations(
      `${APPLE_RUNNER_DIR}src/__tests__/runner-session.test.ts`,
      "import { x } from '../host.ts';",
    ),
    [],
  );
});

test('raw process primitives stay out of runner production source, as a type or in tests only', () => {
  assert.match(
    packageViolations(RUNNER_FILE, "import { spawn } from 'node:child_process';").join('\n'),
    /raw process primitives/,
  );
  assert.deepEqual(
    packageViolations(
      `${APPLE_RUNNER_DIR}src/host.ts`,
      "import type { ChildProcess } from 'node:child_process';",
    ),
    [],
  );
  assert.deepEqual(
    packageViolations(
      `${APPLE_RUNNER_DIR}src/__tests__/runner-xctestrun.test.ts`,
      "import { execFileSync } from 'node:child_process';",
    ),
    [],
  );
});

test('test-kit is test support in the runner package, never production source', () => {
  assert.deepEqual(
    packageViolations(
      `${APPLE_RUNNER_DIR}src/__tests__/host-setup.ts`,
      "import { bindTestCommandHost } from '@agent-device/test-kit';",
    ),
    [],
  );
  assert.match(
    packageViolations(
      RUNNER_FILE,
      "import { bindTestCommandHost } from '@agent-device/test-kit';",
    ).join('\n'),
    /apple-runner may import workspace code only from/,
  );
});

test('the runner entry has platform-apple composition and three named root consumers as production importers', () => {
  const entry = "import { bindAppleRunnerHost } from '@agent-device/apple-runner';";
  assert.deepEqual(
    importerViolations('packages/platform-apple/src/core/runner-client.ts', entry),
    [],
  );
  assert.match(
    importerViolations('packages/daemon/src/execution/selector-runtime.ts', entry).join('\n'),
    /only platform-apple's composition and the named root consumers/,
  );
  assert.match(
    importerViolations(
      'src/cli.ts',
      "import type { RunnerCommand } from '@agent-device/apple-runner';",
    ).join('\n'),
    /only platform-apple's composition and the named root consumers/,
  );
});

test('the named root consumers import the runner entry only as a type or deferred', () => {
  const consumer = 'src/provider-device-runtime.ts';
  assert.deepEqual(
    importerViolations(
      consumer,
      "import type { AppleRunnerProvider } from '@agent-device/apple-runner';",
    ),
    [],
  );
  assert.deepEqual(
    importerViolations(
      consumer,
      "const { withAppleRunnerProvider } = await import('@agent-device/apple-runner');",
    ),
    [],
  );
  assert.match(
    importerViolations(
      consumer,
      "import { withAppleRunnerProvider } from '@agent-device/apple-runner';",
    ).join('\n'),
    /as a type or behind a deferred import/,
  );
});

test('test support may import the runner entry', () => {
  assert.deepEqual(
    importerViolations(
      'packages/daemon/src/execution/__tests__/selector-runtime.test.ts',
      "import { withAppleRunnerProvider } from '@agent-device/apple-runner';",
    ),
    [],
  );
  assert.deepEqual(
    importerViolations(
      'test/integration/provider-scenarios/ios-world.ts',
      "import type { AppleRunnerProvider } from '@agent-device/apple-runner';",
    ),
    [],
  );
});
