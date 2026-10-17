import { createTestHostEnvironment } from '@agent-device/test-kit';
import type { HostEnvironment } from '@agent-device/kernel/source-value';

/** Binds a command that takes a `host` to a fresh test host, so a call site names only its inputs. */
export function withTestHost<P extends { host: HostEnvironment }, R>(
  command: (params: P) => R,
): (params: Omit<P, 'host'>) => R {
  return (params) => command({ host: createTestHostEnvironment(), ...params } as P);
}
