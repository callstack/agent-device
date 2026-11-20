import type { AgentDevicePlugin } from '@agent-device/plugins/contract';
import type { ConnectionProviderCapabilities } from '@agent-device/contracts/remote';

/**
 * The connection capabilities one plugin declaration carries. A test that installs a store plugin
 * with stubbed callbacks still declares the provider's real capabilities this way; the host reads
 * them from the validated claim, not from the declaration.
 */
export function declaredConnectionCapabilities(
  plugin: AgentDevicePlugin,
): ConnectionProviderCapabilities | undefined {
  const contribution = plugin.contributes.find((entry) => entry.kind === 'provider');
  return contribution?.kind === 'provider' ? contribution.connection?.capabilities : undefined;
}
