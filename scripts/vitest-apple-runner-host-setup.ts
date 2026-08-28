import { beforeEach } from 'vitest';
import {
  appleRunnerTestHost,
  installAppleRunnerTestHost,
  loadAppleRunnerHost,
} from '@agent-device/platform-apple/runner/test-host';

// The apple-runner vitest project runs the package's own suites, which cannot
// import root utilities directly (R11). This setup installs the real root host
// capabilities as overridable defaults, so package tests exercise genuine
// retry/lock/exec semantics and stub individual capabilities per test.
installAppleRunnerTestHost(await loadAppleRunnerHost());

beforeEach(() => {
  appleRunnerTestHost.reset();
});
