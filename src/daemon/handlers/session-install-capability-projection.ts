import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { commandDescriptors } from '../../core/command-descriptor/registry.ts';
import type {
  RuntimeOperationFact,
  RuntimeUseDeclaration,
} from '@agent-device/contracts/platform-runtime';
import type { InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';

type InstallFamilyRuntimeUse = RuntimeUseDeclaration;
type DeviceRuntimeFacts = Awaited<ReturnType<InspectDeviceRuntimeFacts>>;

// This is deliberately a narrow transitional projection, not a second capability catalog. The
// public source-install command writes the internal install_source daemon route, so normalize it
// before reading its descriptor. The descriptor owns the required operations in both cases.
const INSTALL_FAMILY_PUBLIC_COMMANDS = new Set<string>([
  PUBLIC_COMMANDS.install,
  PUBLIC_COMMANDS.reinstall,
  PUBLIC_COMMANDS.installFromSource,
  PUBLIC_COMMANDS.push,
]);
const INSTALL_FAMILY_DAEMON_ALIASES = new Map<string, string>([
  [PUBLIC_COMMANDS.installFromSource, INTERNAL_COMMANDS.installSource],
]);

/**
 * The legacy capabilities handler temporarily projects only this unit's four public
 * commands from facts. Wave 6 owns the general capabilities cutover.
 */
export function installFamilyCapabilityAvailable(
  command: string,
  facts: Awaited<ReturnType<InspectDeviceRuntimeFacts>> | undefined,
): boolean | undefined {
  const use = installFamilyCapabilityUse(command);
  if (!use) return undefined;
  return (
    facts !== undefined && use.required.every((operation) => hasAvailableFact(facts, operation))
  );
}

function installFamilyCapabilityUse(command: string): InstallFamilyRuntimeUse | undefined {
  const normalized = normalizeInstallFamilyDaemonCommand(command);
  if (!normalized) return undefined;
  const execution = commandDescriptors.find(
    (descriptor) => descriptor.name === normalized,
  )?.platformExecution;
  if (execution?.kind !== 'device-runtime' || !('use' in execution)) return undefined;
  return execution.use;
}

function normalizeInstallFamilyDaemonCommand(command: string): string | undefined {
  if (!INSTALL_FAMILY_PUBLIC_COMMANDS.has(command)) return undefined;
  return INSTALL_FAMILY_DAEMON_ALIASES.get(command) ?? command;
}

function hasAvailableFact(facts: DeviceRuntimeFacts, operation: string): boolean {
  // Descriptor execution metadata is structurally validated as string arrays. Keep the projection
  // fail-closed when a future descriptor names an operation that is absent from the concrete facts
  // catalog instead of turning an arbitrary property lookup into capability support.
  if (!Object.hasOwn(facts.operations, operation)) return false;
  const fact = (facts.operations as Readonly<Record<string, RuntimeOperationFact>>)[operation];
  return fact?.available === true;
}
