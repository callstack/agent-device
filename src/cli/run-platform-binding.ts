import type { CliFlags } from '@agent-device/contracts/command';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import {
  applyDefaultPlatformBinding,
  getCommandSchema,
  resolveBindingSettings,
} from '@agent-device/command-surface';

export function bindRunPlatform(
  flags: CliFlags,
  command: string,
  host: HostEnvironment,
  binding: ReturnType<typeof resolveBindingSettings>,
): CliFlags {
  if (binding.lockPolicy || getCommandSchema(command)?.explicitOnlyFlags?.includes('platform')) {
    return { ...flags };
  }
  return applyDefaultPlatformBinding(flags, {
    env: host.env,
    policyOverrides: flags,
    configuredPlatform: flags.platform,
    configuredSession: flags.session,
  });
}
