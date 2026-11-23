import assert from 'node:assert/strict';
import { test } from 'vitest';
import { reactDevtoolsInstallCommand } from './plugin-installation.ts';

test.each([
  ['0.22.0-dev', '@nightly-0.22'],
  ['0.22.0-nightly-0-22.20261118.187', '@0.22.0-nightly-0-22.20261118.187'],
  ['0.22.0', ''],
  ['0.23.0-dev', ''],
])('React DevTools selects the install channel for core %s', (coreVersion, suffix) => {
  assert.equal(
    reactDevtoolsInstallCommand(coreVersion),
    `npm install @agent-device/react-devtools${suffix}`,
  );
});
