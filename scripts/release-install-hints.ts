/**
 * Lists, one name per line, every plugin package the checked-out core tells a user to install.
 *
 * Core names a plugin package in three catalogs: the optional platform families ADR 0034 makes
 * installable, the provider plugin catalog `connect` points at, and the replay format declarations.
 * Each row becomes an `agent-device plugins add <package>` line in the shipped help and errors, so
 * this reads the declarations those messages build from rather than a copy of them.
 * `scripts/release-workspace.mjs` compares the result with the packages it packs, so a hint naming a
 * package the release would not publish fails the release instead of shipping a dead command.
 *
 * Run from the repository root, where the workspace links resolve:
 *   node --experimental-strip-types scripts/release-install-hints.ts
 */
import { getReplayPluginInstallation, type ReplayFormat } from '@agent-device/ad-script';
import { OPTIONAL_PLATFORMS } from '@agent-device/contracts/platform-module';
import { getOptionalPlatformPluginDeclaration } from '@agent-device/contracts/plugin-installation';
import { providerPluginDeclarations } from '../src/commands/provider-plugin-catalog.ts';

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
  ...providerPluginDeclarations().map((declaration) => declaration.package),
  ...(Object.keys(replayFormats) as ReplayFormat[]).map(
    (id) => getReplayPluginInstallation(id).package,
  ),
];

process.stdout.write(`${[...new Set(hints)].sort().join('\n')}\n`);
