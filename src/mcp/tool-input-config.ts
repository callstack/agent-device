import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { FlagKey } from '@agent-device/command-registry/flag-types';
import type { CliFlags } from '@agent-device/contracts/command';
import {
  assertSelectorHonorsDevicePin,
  isFlagSupportedForCommand,
  mergeDefinedFlags,
  pickExplicitSelector,
  resolveBindingSettings,
  resolveConfigBackedFlagDefaultsWithProvenance,
  resolveDevicePin,
  type BindingSettings,
  type CommandName,
  type JsonSchema,
} from '@agent-device/command-surface';

/**
 * Merges the operator's env and config-file defaults into one tool call's input, and resolves the
 * session lock from those same defaults. The lock is operator policy: a session or platform the
 * model names never turns it on, as `AGENT_DEVICE_SESSION` does for the CLI.
 */
export function resolveMcpConfigDefaults(
  name: CommandName,
  explicitInput: Record<string, unknown>,
  supportedProperties: Readonly<Record<string, JsonSchema>>,
  host: HostEnvironment,
): { input: Record<string, unknown>; binding: BindingSettings } {
  const { flags: defaults, provenance } = resolveConfigBackedFlagDefaultsWithProvenance({
    command: name,
    cwd: host.cwd,
    env: host.env,
    cliFlags: explicitInput as CliFlags,
  });
  // The pin is operator policy like the lock: a selector the model names must not retarget a
  // pinned project, so it fails here with the same typed reason the CLI raises (#2161).
  const devicePin = resolveDevicePin(defaults, provenance);
  if (devicePin) {
    assertSelectorHonorsDevicePin(
      devicePin,
      pickExplicitSelector(
        explicitInput as Partial<CliFlags>,
        new Set(Object.keys(explicitInput) as FlagKey[]),
      ),
      'input',
    );
  }
  const applicableDefaults: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (
      Object.hasOwn(supportedProperties, key) &&
      isFlagSupportedForCommand(key as FlagKey, name)
    ) {
      applicableDefaults[key] = value;
    }
  }
  return {
    input: mergeDefinedFlags(applicableDefaults, explicitInput),
    binding: resolveBindingSettings({
      env: host.env,
      policyOverrides: { sessionLock: defaults.sessionLock },
      configuredPlatform: defaults.platform,
      configuredSession: defaults.session,
    }),
  };
}
