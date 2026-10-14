import { createCommandSurfaceAgentDevice } from '../../command-runtime/runtime-command-surface.ts';
import type { AgentDeviceRuntimeConfig } from '@agent-device/contracts/runtime-contract';

/**
 * The required `createCommandSurface` port for tests that build daemon param bags directly.
 * Tests reach the device through vi.mock'd seams, so a real factory behind the port never runs
 * command code in these suites; naming the port costs each call site one line, not a fake.
 * The async wrapper matches the production port's load-on-first-use shape while keeping the
 * concrete factory (not the narrowed port alias) so runtime members like `signal` stay visible
 * to the few tests that read them off an assembled runtime.
 */
export const testCreateCommandSurface = async (config: AgentDeviceRuntimeConfig) =>
  createCommandSurfaceAgentDevice(config);
