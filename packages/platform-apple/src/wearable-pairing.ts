import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type {
  PairWearableInput,
  WearablePairingRuntimeResult,
} from '@agent-device/contracts/wearable-pairing-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { scopeSimctlArgsForDevice } from './core/simctl.ts';

type ListedPair = {
  pairId: string;
  phoneId: string;
  wearableId: string;
  state: string;
};

type WatchDeviceInfo = DeviceInfo & { simulatorState: string };

export async function pairAppleWearable(
  host: PlatformRuntimeHost,
  phone: DeviceInfo,
  input: PairWearableInput,
  signal: AbortSignal,
): Promise<WearablePairingRuntimeResult> {
  signal.throwIfAborted();
  const devicesResult = await host.appleTools.run(
    { tool: 'simctl', args: scopeSimctlArgsForDevice(phone, ['list', 'devices', '-j']) },
    signal,
  );
  const wearable = selectWatch(
    parseWatchDevices(devicesResult.stdout, phone.simulatorSetPath),
    input,
  );
  const preRequestPairs = await listPairs(host, phone, signal);
  const preRequestPairIds = new Set(preRequestPairs.map((pair) => pair.pairId));
  const preRequestActivePairs = preRequestPairs.filter((pair) => isPairActive(pair.state));
  const initialWatchState = wearable.simulatorState;
  let bootedHere = false;
  try {
    if (input.boot && initialWatchState === 'Shutdown') {
      bootedHere = true;
      await runRequired(
        host,
        phone,
        ['boot', wearable.id],
        signal,
        'Unable to boot watchOS simulator.',
      );
      await runRequired(
        host,
        phone,
        ['bootstatus', wearable.id, '-b'],
        signal,
        'watchOS simulator did not finish booting.',
      );
      wearable.booted = true;
    } else if (input.boot && initialWatchState === 'Booting') {
      await runRequired(
        host,
        phone,
        ['bootstatus', wearable.id, '-b'],
        signal,
        'watchOS simulator did not finish booting.',
      );
      wearable.booted = true;
    } else if (initialWatchState !== 'Booted' && initialWatchState !== 'Shutdown') {
      throw new AppError(
        'COMMAND_FAILED',
        `Cannot pair a watchOS simulator while it is in state ${initialWatchState}.`,
      );
    }

    let pair = findPair(preRequestPairs, phone.id, wearable.id);
    if (!pair) {
      await runRequired(
        host,
        phone,
        ['pair', phone.id, wearable.id],
        signal,
        'CoreSimulator could not pair the selected phone and watch.',
      );
      pair = findPair(await listPairs(host, phone, signal), phone.id, wearable.id);
    }
    if (!pair) {
      throw new AppError(
        'COMMAND_FAILED',
        'CoreSimulator did not report the newly created wearable pair.',
      );
    }

    if (!isPairActive(pair.state)) {
      await runRequired(
        host,
        phone,
        ['pair_activate', pair.pairId],
        signal,
        'CoreSimulator could not activate the wearable pair.',
      );
      pair = findPair(await listPairs(host, phone, signal), phone.id, wearable.id) ?? pair;
    }
    return {
      pairId: pair.pairId,
      phone,
      wearable,
      status: hasPairState(pair.state, 'connected') ? 'connected' : 'paired',
    };
  } catch (error) {
    await rollbackNewPairs(host, phone, preRequestPairIds, preRequestActivePairs);
    if (bootedHere) {
      await host.appleTools
        .run(
          {
            tool: 'simctl',
            args: scopeSimctlArgsForDevice(phone, ['shutdown', wearable.id]),
            allowFailure: true,
          },
          undefined,
        )
        .catch(() => undefined);
    }
    throw error;
  }
}

function isPairActive(state: string): boolean {
  return hasPairState(state, 'active') || hasPairState(state, 'connected');
}

async function rollbackNewPairs(
  host: PlatformRuntimeHost,
  phone: DeviceInfo,
  preRequestPairIds: ReadonlySet<string>,
  preRequestActivePairs: readonly ListedPair[],
): Promise<void> {
  const currentPairs = await listPairs(host, phone).catch(() => []);
  for (const pair of currentPairs) {
    if (preRequestPairIds.has(pair.pairId)) continue;
    await host.appleTools
      .run(
        {
          tool: 'simctl',
          args: scopeSimctlArgsForDevice(phone, ['unpair', pair.pairId]),
          allowFailure: true,
        },
        undefined,
      )
      .catch(() => undefined);
  }
  for (const pair of preRequestActivePairs) {
    await host.appleTools
      .run(
        {
          tool: 'simctl',
          args: scopeSimctlArgsForDevice(phone, ['pair_activate', pair.pairId]),
          allowFailure: true,
        },
        undefined,
      )
      .catch(() => undefined);
  }
}

function hasPairState(state: string, expected: 'active' | 'connected'): boolean {
  return state
    .toLowerCase()
    .split(/[^a-z]+/)
    .includes(expected);
}

// CoreSimulator's nested inventory is normalized here so selection never depends on raw JSON.
// fallow-ignore-next-line complexity
function parseWatchDevices(stdout: string, simulatorSetPath?: string): WatchDeviceInfo[] {
  let payload: {
    devices?: Record<
      string,
      Array<{ name?: string; udid?: string; state?: string; isAvailable?: boolean }>
    >;
  };
  try {
    payload = JSON.parse(stdout) as typeof payload;
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      'Failed to parse CoreSimulator device inventory.',
      undefined,
      error,
    );
  }
  const devices: WatchDeviceInfo[] = [];
  for (const [runtime, entries] of Object.entries(payload.devices ?? {})) {
    if (!runtime.toLowerCase().includes('watchos')) continue;
    for (const entry of entries) {
      if (entry.isAvailable === false || !entry.udid) continue;
      devices.push({
        platform: 'apple',
        id: entry.udid,
        name: entry.name ?? entry.udid,
        kind: 'simulator',
        target: 'mobile',
        appleOs: 'watchos',
        booted: entry.state === 'Booted',
        simulatorState: entry.state ?? 'Unknown',
        ...(simulatorSetPath ? { simulatorSetPath } : {}),
      });
    }
  }
  return devices;
}

function selectWatch(devices: WatchDeviceInfo[], input: PairWearableInput): WatchDeviceInfo {
  const requested = input.wearable;
  const matches = devices.filter(
    (device) =>
      (!requested?.deviceId || device.id === requested.deviceId) &&
      (!requested?.name || device.name === requested.name),
  );
  if (matches.length === 1) return { ...matches[0]! };
  if (matches.length === 0) {
    throw new AppError('DEVICE_NOT_FOUND', 'No matching watchOS simulator is available.');
  }
  throw new AppError(
    'INVALID_ARGS',
    'More than one watchOS simulator matches; provide deviceId or name.',
    {
      candidates: matches.map(({ id, name }) => ({ id, name })),
    },
  );
}

async function listPairs(
  host: PlatformRuntimeHost,
  phone: DeviceInfo,
  signal?: AbortSignal,
): Promise<ListedPair[]> {
  const result = await host.appleTools.run(
    { tool: 'simctl', args: scopeSimctlArgsForDevice(phone, ['list', 'pairs', '-j']) },
    signal,
  );
  try {
    const payload = JSON.parse(result.stdout) as { pairs?: Record<string, unknown> };
    return Object.entries(payload.pairs ?? {}).flatMap(([pairId, raw]) => {
      if (!raw || typeof raw !== 'object') return [];
      const pair = raw as Record<string, unknown>;
      const phoneId = readNestedId(pair.phone);
      const wearableId = readNestedId(pair.watch ?? pair.wearable);
      if (!phoneId || !wearableId) return [];
      return [{ pairId, phoneId, wearableId, state: String(pair.state ?? '') }];
    });
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      'Failed to parse CoreSimulator pair inventory.',
      undefined,
      error,
    );
  }
}

function readNestedId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const id = record.udid ?? record.identifier ?? record.deviceIdentifier;
  return typeof id === 'string' ? id : undefined;
}

function findPair(
  pairs: ListedPair[],
  phoneId: string,
  wearableId: string,
): ListedPair | undefined {
  return pairs.find((pair) => pair.phoneId === phoneId && pair.wearableId === wearableId);
}

async function runRequired(
  host: PlatformRuntimeHost,
  phone: DeviceInfo,
  args: string[],
  signal: AbortSignal,
  message: string,
) {
  const result = await host.appleTools.run(
    { tool: 'simctl', args: scopeSimctlArgsForDevice(phone, args), allowFailure: true },
    signal,
  );
  if (result.exitCode !== 0) {
    throw new AppError('COMMAND_FAILED', message, {
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }
  return result;
}
