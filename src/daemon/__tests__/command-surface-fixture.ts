import { createCommandSurfaceAgentDevice } from '../../command-runtime/runtime-command-surface.ts';

/**
 * The required `createCommandSurface` port for tests that build daemon param bags directly.
 * Tests reach the device through vi.mock'd seams, so a real factory behind the port never runs
 * command code in these suites; naming the port costs each call site one line, not a fake.
 * The concrete function type (not the narrowed port alias) keeps runtime members like `signal`
 * visible to the few tests that read them off an assembled runtime.
 */
export const testCreateCommandSurface = createCommandSurfaceAgentDevice;
