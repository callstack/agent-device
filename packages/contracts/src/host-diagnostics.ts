import type { DeviceInfo, PlatformSelector } from '@agent-device/kernel/device';
import type { DoctorCheck } from './doctor.ts';

/**
 * Per-call context for host-scoped diagnostics (`doctor`, ADR 0019 host execution). The daemon
 * supplies it; each family's contribution reads only what its probes need. Fields stay
 * platform-neutral — a family-specific transport override travels opaquely and is narrowed by
 * the one family that owns it.
 */
export type HostDiagnosticsContext = Readonly<{
  stateDir: string;
  metroPort: number;
  shouldProbeMetro: boolean;
  isProviderDevice(device: DeviceInfo): boolean;
  emitProgress(message: string): void;
  listLocalDeviceInventory(
    query: Readonly<{ platform: PlatformSelector; target?: DeviceInfo['target'] }>,
  ): Promise<readonly DeviceInfo[]>;
  shouldPropagateInventoryProbeError(error: unknown): boolean;
  /** Request-scoped family transport overrides (e.g. a provider-composed adb executor). */
  transportOverrides: Readonly<{ androidAdb?: unknown }>;
}>;

/**
 * The neutral surface platform families contribute host-scoped diagnostics through. The daemon
 * orchestrates which method runs when and for which device; families own every probe body.
 * Implementations are composed at the root with lazy family loading — a family whose method is
 * never called for a request loads nothing.
 */
export type HostDiagnostics = Readonly<{
  /** The requested family's single `toolchain` check; families without one yield undefined. */
  toolchainCheck(
    platform: PlatformSelector | undefined,
    context: HostDiagnosticsContext,
  ): Promise<DoctorCheck | undefined>;
  /** Family-owned checks for a resolved device (transport reverse mappings, orphaned IMEs). */
  deviceChecks(
    device: DeviceInfo,
    context: HostDiagnosticsContext,
  ): Promise<readonly DoctorCheck[]>;
  /** Host-wide checks that run on every local doctor regardless of device (browser census). */
  ambientChecks(context: HostDiagnosticsContext): Promise<readonly DoctorCheck[]>;
  /** Family artifact pre-build for a prospective device, so a first `open` starts warm. */
  warmupCheck(
    device: DeviceInfo,
    context: HostDiagnosticsContext,
  ): Promise<DoctorCheck | undefined>;
}>;
