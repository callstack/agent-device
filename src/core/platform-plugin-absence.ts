import type { Platform } from '@agent-device/kernel/device';
import type { AppError } from '@agent-device/kernel/errors';
import { missingOptionalPlatformError } from '@agent-device/contracts/platform-module';
import { readVersion } from '@agent-device/host-kit/version';

/**
 * How this runtime reports a platform family its composition lacks (ADR 0034).
 *
 * Both platform lookups — the family module registry and the platform-plugin registry — answer an
 * absent family through a reporter like this one, supplied where the runtime composes them. It lives
 * here rather than in either registry because naming the package that provides a family needs the
 * running core's version, and reading that version is host mechanics: `@agent-device/host-kit`
 * reaches the daemon and CLI eagerly, so a registry that imported it would grow the loading shape of
 * every entry that reaches the platform registries (ADR 0019).
 */
export function missingPlatformPlugin(family: Platform): AppError {
  return missingOptionalPlatformError(family, readVersion());
}
