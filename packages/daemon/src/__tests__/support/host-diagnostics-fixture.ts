import { vi } from 'vitest';
import type { DoctorCheck } from '@agent-device/contracts/observability';
import type { HostDiagnostics } from '@agent-device/contracts/host-diagnostics';

/**
 * The `HostDiagnostics` port as the daemon suites need it: the doctor route's decisions — which
 * probe runs for which device, how probe results are appended, ordered, and shaped into check
 * lines, and what policy admits — are daemon code; the toolchain probes themselves belong to the
 * platform packages. Suite code overrides the single probe it cares about or asserts on the
 * spy's call arguments, exactly as production wiring replaces one composed capability.
 */
export function hostDiagnosticsFixture(overrides: Partial<HostDiagnostics> = {}): HostDiagnostics {
  return Object.freeze({
    toolchainCheck: vi.fn(async () => undefined),
    deviceChecks: vi.fn(async () => [] as readonly DoctorCheck[]),
    ambientChecks: vi.fn(async () => [] as readonly DoctorCheck[]),
    warmupCheck: vi.fn(async () => undefined),
    ...overrides,
  });
}
