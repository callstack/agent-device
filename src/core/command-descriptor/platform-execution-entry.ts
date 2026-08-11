import {
  assertCommandPlatformExecution,
  type CommandPlatformExecution,
} from '@agent-device/contracts/platform';

/**
 * The shape the entry gate reads. Structural on purpose: the registry's raw
 * descriptor type is derived from this module's consumer, and the gate must be
 * able to see an *absent* discriminator, which a nominal type cannot express.
 */
type PlatformExecutionDeclarationSite = {
  readonly name: string;
  readonly capability?: unknown;
  readonly platformExecution?: unknown;
};

/**
 * ADR 0019 §6: every command descriptor declares its platform-execution mode
 * explicitly. A registry-entry default cannot distinguish a command with *no*
 * platform execution (`none`) from an unmigrated one (`legacy`), which is what
 * makes the migration denominator machine-readable — so an undeclared
 * discriminator is a registry-load error, not a silently defaulted value.
 *
 * The same gate rejects `none` on a descriptor that still owns a capability
 * bucket: capability buckets are legacy platform admission, and a command that
 * admits per platform executes platform behavior by definition.
 */
export function readDeclaredPlatformExecution(
  descriptor: PlatformExecutionDeclarationSite,
): CommandPlatformExecution {
  const declared = descriptor.platformExecution;
  if (declared === undefined) {
    throw new TypeError(
      `Command descriptor "${descriptor.name}" must declare platformExecution (none, legacy, inventory, or device-runtime); there is no registry-entry default`,
    );
  }
  assertCommandPlatformExecution(declared);
  if (declared.kind === 'none' && descriptor.capability !== undefined) {
    throw new TypeError(
      `Command descriptor "${descriptor.name}" declares platformExecution none but keeps a capability bucket; a command with platform admission is not platform-free`,
    );
  }
  return declared;
}
