import type { HostEnvironment } from '@agent-device/kernel/source-value';

/** The process-shaped object an entry point captures: Node's `process` satisfies it. */
export type HostEnvironmentSource = Readonly<{
  env: HostEnvironment['env'];
  cwd(): string;
}>;

/**
 * Snapshots the environment and working directory of `source`, which an entry point passes as
 * `process`. The environment is copied, so later changes to the source never reach the capture.
 */
export function captureHostEnvironment(source: HostEnvironmentSource): HostEnvironment {
  return { env: { ...source.env }, cwd: source.cwd() };
}
