import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { HostEnvironmentSource } from './internal/host-process-types.ts';

/** Copies the environment and captures the working directory. */
export function captureHostEnvironment(source: HostEnvironmentSource): HostEnvironment {
  return { env: { ...source.env }, cwd: source.cwd() };
}
