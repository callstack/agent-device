import type { AppleRunnerHost } from '@agent-device/apple-runner';
import { provideTestHostDefaults } from '@agent-device/test-kit';
import { appleRunnerHost } from '../core/runner-host.ts';

// The apple-runner package cannot import platform-apple, so the package's vitest project takes
// the real host capabilities from here: this file provides them and the package's own setup
// (`packages/apple-runner/src/__tests__/host-setup.ts`) installs them behind its test-host seam.
provideTestHostDefaults<AppleRunnerHost>('apple-runner', appleRunnerHost);
