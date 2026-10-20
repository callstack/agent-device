import { createRuntimeStateHandle } from '@agent-device/host-kit/runtime-slots';

export type { RuntimeStateHandle as TestRuntimeStateHandle } from '@agent-device/host-kit/runtime-slots';

/**
 * The state of one test runtime: a handle over host-kit's one slot store, entered with `run` and
 * released with `dispose`. A test that exercises per-runtime state enters its own handles, so two
 * "runtimes" in one test never share it, and nothing leaks into the standalone state that code
 * outside any runtime reads (#3794). Production code never calls this: the daemon runtime owns
 * the one handle it creates at start, and a test that boots a real daemon needs no handle of its
 * own.
 */
export function createTestRuntimeStateHandle(): ReturnType<typeof createRuntimeStateHandle> {
  return createRuntimeStateHandle();
}
