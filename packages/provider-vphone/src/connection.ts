import type { CliFlags } from '@agent-device/contracts/command';
import type { ProviderConnectionVerification } from '@agent-device/contracts/remote';
import { rejectRefusedProviderProfileFields } from '@agent-device/contracts/provider-profile-fields';
import type { ProviderPluginHost, PluginConnectionContext } from 'agent-device/plugins';
import { AppError } from '@agent-device/kernel/errors';
import {
  createVphoneTransport,
  type VphoneTransport,
  type VphoneTransportOptions,
} from './transport.ts';
import { VPHONE_PROFILE_FIELDS } from './profile-fields.ts';

export const VPHONE_PROVIDER = 'vphone';

export const VPHONE_REQUIRED_METHODS = Object.freeze([
  'apps.foreground',
  'apps.launch',
  'apps.open_url',
  'apps.terminate',
  'device.info',
  'device.screen',
  'input.double_tap',
  'input.long_press',
  'input.swipe',
  'input.tap',
  'input.type',
  'ui.tree',
] as const);

export type VphoneMachine = Readonly<{
  name: string;
  state: string;
  udid?: string;
}>;

export function createVphoneConnection(
  options: VphoneTransportOptions,
  transport = createVphoneTransport(options),
) {
  return Object.freeze({
    resolve: ({ flags }: Pick<PluginConnectionContext, 'flags'>) => ({
      profile: {
        leaseProvider: VPHONE_PROVIDER,
        platform: 'ios' as const,
        target: 'mobile' as const,
        device: requireMachine(flags),
      },
    }),
    verify: async ({ flags }: { flags: CliFlags }): Promise<ProviderConnectionVerification> => {
      const machine = await verifyVphoneMachine(transport, requireMachine(flags));
      return {
        provider: VPHONE_PROVIDER,
        service: 'vphone',
        verificationMessage: `Attached to running vphone machine ${machine.name}.`,
        device: {
          status: 'verified',
          name: machine.name,
          reference: machine.udid ?? machine.name,
          platform: 'ios',
          availability: 'running',
        },
        app: { status: 'deferred', message: 'Select an installed bundle ID with open.' },
      };
    },
  });
}

export async function verifyVphoneMachine(
  transport: VphoneTransport,
  name: string,
  signal?: AbortSignal,
): Promise<VphoneMachine> {
  const listed = await transport.json(['vm', 'list'], { signal });
  if (!Array.isArray(listed)) throw invalidMachineInventory();
  const matches = listed.filter((value): value is VphoneMachine => {
    if (!isRecord(value) || value.name !== name || typeof value.state !== 'string') return false;
    return value.udid === undefined || typeof value.udid === 'string';
  });
  if (matches.length === 0) {
    throw new AppError('DEVICE_NOT_FOUND', `vphone machine ${name} was not found.`, {
      reason: 'vphone_machine_missing',
    });
  }
  if (matches.length !== 1) {
    throw new AppError('INVALID_ARGS', `vphone machine name ${name} is ambiguous.`, {
      reason: 'vphone_machine_ambiguous',
    });
  }
  const machine = matches[0]!;
  if (machine.state !== 'running') {
    throw new AppError(
      'COMMAND_FAILED',
      `vphone machine ${name} is ${machine.state}; start it outside agent-device before connecting.`,
      { reason: 'vphone_machine_not_running' },
    );
  }
  const catalog = await transport.rpc(name, 'methods.list', {}, { signal });
  if (!isRecord(catalog) || !Array.isArray(catalog.methods)) throw invalidMethodCatalog();
  const methods = new Set(
    catalog.methods.flatMap((entry) =>
      isRecord(entry) && typeof entry.name === 'string' ? [entry.name] : [],
    ),
  );
  const missing = VPHONE_REQUIRED_METHODS.filter((method) => !methods.has(method));
  if (missing.length > 0) {
    throw new AppError('UNSUPPORTED_OPERATION', 'The vphone guest lacks required RPC methods.', {
      reason: 'vphone_methods_missing',
      missingMethods: missing,
    });
  }
  return machine;
}

function requireMachine(flags: CliFlags): string {
  rejectRefusedProviderProfileFields(flags, VPHONE_PROFILE_FIELDS);
  if (flags.platform !== 'ios') {
    throw new AppError('INVALID_ARGS', 'connect vphone requires --platform ios.');
  }
  const machine = flags.device?.trim();
  if (!machine) {
    throw new AppError('INVALID_ARGS', 'connect vphone requires --device <running-machine-name>.');
  }
  return machine;
}

function invalidMachineInventory(): AppError {
  return new AppError('COMMAND_FAILED', 'vphone vm list returned an invalid machine inventory.', {
    reason: 'vphone_invalid_response',
  });
}

function invalidMethodCatalog(): AppError {
  return new AppError('COMMAND_FAILED', 'vphone methods.list returned an invalid catalog.', {
    reason: 'vphone_invalid_response',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function vphoneTransportOptions(
  host: ProviderPluginHost,
  options: VphoneTransportOptions,
): VphoneTransportOptions {
  return { ...options, cli: options.cli ?? host.env.VPHONE_CLI, env: options.env ?? host.env };
}
