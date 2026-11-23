/**
 * Lists, one name per line, every plugin package the checked-out core tells a user to install.
 *
 * Core names optional packages in the optional platform families ADR 0034 makes
 * installable, the macOS leaf the Apple owner delegates to, the provider plugin catalog `connect`
 * points at, the replay format declarations, and the React DevTools command.
 * Each row becomes an install command in the shipped help and errors, so
 * this reads the declarations those messages build from rather than a copy of them.
 * `scripts/release-workspace.mjs` compares the result with the packages it packs, so a hint naming a
 * package the release would not publish fails the release instead of shipping a dead command.
 *
 * Run from the repository root, where the workspace links resolve:
 *   node --experimental-strip-types scripts/release-install-hints.ts
 */
import { providerPluginDeclarations } from '@agent-device/contracts/provider-plugin-catalog';
import { getReplayPluginInstallation, type ReplayFormat } from '@agent-device/ad-script';
import { OPTIONAL_PLATFORMS } from '@agent-device/contracts/platform-module';
import {
  getOptionalPlatformPluginDeclaration,
  MACOS_PLATFORM_PLUGIN_DECLARATION,
  REACT_DEVTOOLS_PACKAGE,
} from '@agent-device/contracts/plugin-installation';

// Totals `ReplayFormat`, so TypeScript refuses a new replay format without an installation row —
// the same shape the optional-platform catalog enforces.
const replayFormats: Record<ReplayFormat, true> = { ad: true, maestro: true };

function optionalPlatformPackages(): string[] {
  return OPTIONAL_PLATFORMS.map((family) => {
    const declaration = getOptionalPlatformPluginDeclaration(family);
    if (!declaration) {
      throw new Error(`Optional platform ${family} has no plugin installation declaration.`);
    }
    return declaration.package;
  });
}

const hints = [
  ...optionalPlatformPackages(),
  MACOS_PLATFORM_PLUGIN_DECLARATION.package,
  REACT_DEVTOOLS_PACKAGE.package,
  ...providerPluginDeclarations().map((declaration) => declaration.package),
  ...(Object.keys(replayFormats) as ReplayFormat[]).map(
    (id) => getReplayPluginInstallation(id).package,
  ),
];

process.stdout.write(`${[...new Set(hints)].sort().join('\n')}\n`);
