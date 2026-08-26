import { beforeEach } from 'vitest';
import {
  appleRunnerTestHost,
  installAppleRunnerTestHost,
} from '@agent-device/platform-apple/runner/test-host';
import { appleRunnerHost } from '../src/platforms/apple/core/runner-host.ts';

// The apple-runner vitest project runs the package's own suites, which cannot
// import root utilities directly (R11). This setup installs the real root host
// capabilities as overridable defaults, so package tests exercise genuine
// retry/lock/exec semantics and stub individual capabilities per test.
installAppleRunnerTestHost(appleRunnerHost);

beforeEach(() => {
  appleRunnerTestHost.reset();
});
