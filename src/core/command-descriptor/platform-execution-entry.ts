import {
  assertCommandPlatformExecution,
  type CommandPlatformExecution,
} from '@agent-device/contracts/command-platform-execution';

/**
 * Structural on purpose: the gate must see an *absent* discriminator, and the
 * registry's raw descriptor type — which forbids that — lives in this module's
 * consumer.
 */
type PlatformExecutionDeclarationSite = {
  readonly name: string;
  readonly capability?: unknown;
  readonly platformExecution?: unknown;
};

/**
 * ADR 0019 §6: every descriptor declares its platform-execution mode explicitly.
 * An undeclared discriminator is a registry-load error, so a command cannot
 * acquire platform execution by omission.
 *
 * `none` with a capability bucket is also rejected: a capability bucket is
 * platform admission, so the command executes platform behavior. `host` is held
 * to the same rule — host-scoped diagnostics carry no per-device admission.
 *
 * This gate sees one descriptor at a time. Platform execution delegated to
 * another command is covered by the CLI-route dominance gate in
 * `__tests__/platform-execution-cli-route.test.ts`.
 */
export function readDeclaredPlatformExecution(
  descriptor: PlatformExecutionDeclarationSite,
): CommandPlatformExecution {
  const declared = descriptor.platformExecution;
  if (declared === undefined) {
    throw new TypeError(
      `Command descriptor "${descriptor.name}" must declare platformExecution (none, host, inventory, or device-runtime); there is no registry-entry default`,
    );
  }
  assertCommandPlatformExecution(declared);
  if (
    (declared.kind === 'none' || declared.kind === 'host') &&
    descriptor.capability !== undefined
  ) {
    throw new TypeError(
      `Command descriptor "${descriptor.name}" declares platformExecution ${declared.kind} but keeps a capability bucket; a command with platform admission is not platform-free`,
    );
  }
  return declared;
}
