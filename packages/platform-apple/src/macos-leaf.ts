import type {
  MacOsPlatformLeafRegistration,
  MacOsPlatformLeafSelection,
} from '@agent-device/contracts/macos-platform-leaf';
import { missingMacOsPlatformError } from '@agent-device/contracts/plugin-installation';
import { readVersion } from '@agent-device/host-kit/version';

/**
 * The macOS leaf port of the bundled Apple owner (ADR 0034, issue #4675).
 *
 * The owner keeps the `apple` family claim and every iOS and tvOS route. macOS desktop automation
 * belongs to the managed `@agent-device/macos` package, which holds the leaf claim. The composition
 * root binds the process's leaf selection here once, and every macOS branch of the owner asks this
 * port for the leaf. The port is process-wide because the owner's entry points take a device, not
 * a composition.
 */
let boundSelection: MacOsPlatformLeafSelection | undefined;

/**
 * Binds the macOS leaf selection of the process. The composition root calls this for the selection
 * that is the process's whole platform selection, never for one narrowed to a single family.
 */
export function bindMacOsLeaf(selection: MacOsPlatformLeafSelection): void {
  boundSelection = selection;
}

/** Whether a package holds the macOS leaf, which decides if this host lists its Mac as a device. */
export function isMacOsLeafInstalled(): boolean {
  return boundSelection?.active !== undefined;
}

/**
 * The installed macOS leaf. An absent package raises the typed `plugin-not-installed` outcome with
 * the install command; a package that failed to load raises its own error.
 */
export function requireMacOsLeaf(): MacOsPlatformLeafRegistration {
  if (!boundSelection) throw missingMacOsPlatformError(readVersion());
  return boundSelection.get();
}
