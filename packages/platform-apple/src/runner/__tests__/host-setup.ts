import { beforeEach } from 'vitest';
import { bindTestCommandHost } from '@agent-device/test-kit';
import {
  appleRunnerTestHost,
  installAppleRunnerTestHost,
  loadAppleRunnerHost,
} from '../test-host.ts';
import { setAppleRunnerHostEnvironment } from '../../core/runner-owner-state.ts';

// The apple-runner vitest project runs the package's own suites, which cannot
// import root utilities directly (R11). This setup installs the real root host
// capabilities as overridable defaults, so package tests exercise genuine
// retry/lock/exec semantics and stub individual capabilities per test.
installAppleRunnerTestHost(await loadAppleRunnerHost());

// Runner code reads its settings from the command host; tests run as one whose environment is the
// live process environment, so `vi.stubEnv` reaches it.
bindTestCommandHost();

beforeEach(() => {
  appleRunnerTestHost.reset();
  // Runner configuration reads take the runtime's host (#3794). A package suite runs outside a
  // composed runtime, so it binds the live process host the command host above carries.
  setAppleRunnerHostEnvironment({ env: process.env, cwd: process.cwd() });
});
