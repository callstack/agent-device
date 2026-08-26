import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { DoctorCheck } from '@agent-device/contracts/observability';
import type { HostDiagnosticsContext } from '@agent-device/contracts/host-diagnostics';
import { firstOutputLine, TOOLCHAIN_TIMEOUT_MS } from '../toolchain-probe.ts';
import { resolveVegaToolProvider } from './tool-provider.ts';

type VegaInventoryProbe = Readonly<{
  devices: readonly DeviceInfo[];
  listedSerials: readonly string[];
}>;

export async function vegaToolchainCheck(context: HostDiagnosticsContext): Promise<DoctorCheck> {
  const provider = resolveVegaToolProvider();
  if (!(await provider.isAvailable())) {
    return {
      id: 'toolchain',
      status: 'info',
      summary: 'Vega toolchain: Vega CLI not found.',
      hint: 'Install Vega Developer Tools or ensure ~/vega/bin/vega is executable.',
      command: 'vega --version',
    };
  }

  const version = await provider.version({
    allowFailure: true,
    timeoutMs: TOOLCHAIN_TIMEOUT_MS,
  });
  const inventory = await readLocalVegaInventory(context);
  const versionLine = firstOutputLine(version.stdout);
  const hasRunningVvd = inventory.devices.some(
    (device) =>
      device.platform === 'vega' &&
      device.kind === 'emulator' &&
      device.target === 'tv' &&
      device.booted === true,
  );

  return {
    id: 'toolchain',
    status: version.exitCode === 0 ? 'pass' : 'info',
    summary: versionLine
      ? `Vega toolchain: ${versionLine}; ${hasRunningVvd ? 'VVD running' : 'no running VVD'}.`
      : 'Vega toolchain: CLI found but version check failed.',
    hint: hasRunningVvd ? undefined : 'Start the Vega Virtual Device and retry doctor.',
    evidence: {
      vegaVersion: versionLine ?? null,
      deviceList: vegaInventoryEvidence(inventory),
    },
  };
}

async function readLocalVegaInventory(
  context: HostDiagnosticsContext,
): Promise<VegaInventoryProbe> {
  try {
    return {
      devices: await context.listLocalDeviceInventory({ platform: 'vega', target: 'tv' }),
      listedSerials: [],
    };
  } catch (error) {
    if (context.shouldPropagateInventoryProbeError(error)) throw error;
    return { devices: [], listedSerials: listedVegaSerials(error) };
  }
}

function listedVegaSerials(error: unknown): readonly string[] {
  if (!(error instanceof AppError) || error.code !== 'DEVICE_NOT_FOUND') return [];
  const listed = error.details?.listedSerials;
  return isStringArray(listed) ? listed : [];
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function vegaInventoryEvidence(inventory: VegaInventoryProbe): string | null {
  const serials =
    inventory.devices.length > 0
      ? inventory.devices.map((device) => device.id)
      : inventory.listedSerials;
  return serials.join(', ') || null;
}
