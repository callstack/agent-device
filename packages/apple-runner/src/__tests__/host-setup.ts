import { beforeEach } from 'vitest';
import {
  bindTestCommandHost,
  createLiveTestHostEnvironment,
  requireTestHostDefaults,
} from '@agent-device/test-kit';
import type { AppleRunnerHost } from '../host.ts';
import { appleRunnerTestHost, installAppleRunnerTestHost } from '../test-host.ts';
import { stubbedAppleDeveloperDir } from './apple-toolchain-fixtures.ts';

// The apple-runner vitest project runs the package's own suites against the real `platform-apple`
// host capabilities as overridable defaults, so package tests exercise genuine retry/lock/exec
// semantics and stub individual capabilities per test. `platform-apple` provides them
// (`packages/platform-apple/src/__tests__/apple-runner-host-setup.ts`); this setup installs them
// and resets the overrides before each case.
installAppleRunnerTestHost(requireTestHostDefaults<AppleRunnerHost>('apple-runner'));

// Runner code reads its settings from the command host; tests run as one whose environment is the
// live process environment, so `vi.stubEnv` reaches it.
bindTestCommandHost();

beforeEach(() => {
  appleRunnerTestHost.reset();
  appleRunnerTestHost.update({
    // The runner cache key reads the selected Xcode's files. A suite reads a stubbed Xcode rather than
    // the host's, which CI hosts outside macOS do not have; a case that selects one overrides this.
    commandDeveloperDir: stubbedAppleDeveloperDir,
    // Runner configuration reads take the runtime's host (#3794). A package suite runs outside a
    // composed runtime, so it answers with the live process host the command host above carries.
    hostEnvironment: createLiveTestHostEnvironment,
  });
});
