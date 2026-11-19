import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { FlagKey } from '@agent-device/command-registry/flag-types';
import type { CliFlags } from '@agent-device/contracts/command';
import {
  isFlagSupportedForCommand,
  mergeDefinedFlags,
  resolveBindingSettings,
  resolveConfigDefaults,
  type BindingSettings,
  type CommandName,
  type DevicePin,
  type JsonSchema,
} from '@agent-device/command-surface';

/** Applies operator config to a tool call without admitting policy settings from tool input. */
export function resolveMcpConfigDefaults(
  name: CommandName,
  explicitInput: Record<string, unknown>,
  supportedProperties: Readonly<Record<string, JsonSchema>>,
  host: HostEnvironment,
): { input: Record<string, unknown>; binding: BindingSettings; devicePin: DevicePin | undefined } {
  const configDefaults = resolveConfigDefaults({
    command: name,
    cwd: host.cwd,
    env: host.env,
    cliFlags: explicitInput as CliFlags,
  });
  const defaults = configDefaults.flags;
  const devicePin = configDefaults.devicePin;
  const applicableDefaults: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (
      Object.hasOwn(supportedProperties, key) &&
      isFlagSupportedForCommand(key as FlagKey, name)
    ) {
      applicableDefaults[key] = value;
    }
  }
  // A config default must never change a gesture kind it was not requested for: pan reads its
  // hold only from the tool call's own holdMs field, so a press-oriented config holdMs neither
  // makes a pan hold nor fails a two-finger pan.
  if (
    name === 'gesture' &&
    explicitInput.kind === 'pan' &&
    !Object.hasOwn(explicitInput, 'holdMs')
  ) {
    delete applicableDefaults.holdMs;
  }
  return {
    input: mergeDefinedFlags(applicableDefaults, explicitInput),
    binding: resolveBindingSettings({
      env: host.env,
      policyOverrides: { sessionLock: defaults.sessionLock },
      configuredPlatform: defaults.platform,
      configuredSession: defaults.session,
    }),
    devicePin,
  };
}
