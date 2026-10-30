import { beforeEach } from 'vitest';
import { bindTestCommandHost, createLiveTestHostEnvironment } from '@agent-device/test-kit';
import { appleRunnerTestHost, installAppleRunnerTestHost } from '../test-host.ts';
import { stubbedAppleDeveloperDir } from './apple-toolchain-fixtures.ts';
import { createAppleRunnerTestHostDefaults } from './test-host-defaults.ts';

// The apple-runner vitest project runs the package's own suites against a package-local host:
// real host-kit and kernel capabilities with explicit Apple test adapters (`test-host-defaults.ts`),
// overridable per test. This setup installs it and resets the overrides before each case.
installAppleRunnerTestHost(createAppleRunnerTestHostDefaults());

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
