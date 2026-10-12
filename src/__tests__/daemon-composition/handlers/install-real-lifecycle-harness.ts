import { setHarnessLifecycleOperationsLoader } from '../../../daemon/handlers/__tests__/session-command-harness.ts';
import { applicationLifecycleRuntimeFixture } from '../application-lifecycle-runtime-fixture.ts';

// Composition suites bind the REAL composed lifecycle (root gateway + apple/android application
// tools) behind the daemon session-command harness. Import this module before any module that
// captures the harness's `handleSessionCommands`: vitest evaluates this file's module graph first,
// and every test file gets its own module instance, so the install cannot leak into daemon files.
setHarnessLifecycleOperationsLoader(applicationLifecycleRuntimeFixture);
