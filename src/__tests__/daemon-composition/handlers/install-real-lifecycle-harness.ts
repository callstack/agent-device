import { setHarnessLifecycleOperationsLoader } from '../../../daemon/handlers/__tests__/session-command-harness.ts';
import { applicationLifecycleRuntimeFixture } from '../application-lifecycle-runtime-fixture.ts';

// Composition suites bind the REAL composed lifecycle (root gateway + apple/android application
// tools) behind the daemon session-command harness. The loader is read when bindings are built,
// so any import position works; vitest gives every test file its own module instance, so the
// install cannot leak into daemon-lane files.
setHarnessLifecycleOperationsLoader(applicationLifecycleRuntimeFixture);
