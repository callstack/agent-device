import type {
  HarmonyPlatformRegistration,
  HarmonyPlatformSelection,
  LinuxPlatformRegistration,
  LinuxPlatformSelection,
  PlatformModuleSelection,
  PlatformPlugin,
  VegaPlatformRegistration,
  VegaPlatformSelection,
  WebPlatformSelection,
  WebPlatformRegistration,
} from '@agent-device/contracts/platform-plugin';
import type { PluginInventoryEntry } from '@agent-device/contracts/plugin-inventory';
import type { Platform } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { PluginCandidate, ProviderRegistry } from '@agent-device/plugins/registry';
import { getOptionalPlatformPluginDeclaration } from '@agent-device/contracts/plugin-installation';
import { BUILTIN_PLATFORM_PLUGINS } from '../core/interactors/register-builtins.ts';
import { registerPlatformPluginSet } from '../core/platform-plugin-registry.ts';
import { missingPlatformPlugin } from '../core/platform-plugin-absence.ts';

type RuntimePlatformPlugin = PlatformPlugin & {
  web?: WebPlatformRegistration;
  vega?: VegaPlatformRegistration;
  harmony?: HarmonyPlatformRegistration;
  linux?: LinuxPlatformRegistration;
};

export function builtinPlatformCandidates(): readonly PluginCandidate[] {
  return [
    {
      source: 'builtin',
      dormant: true,
      declaredClaims: BUILTIN_PLATFORM_PLUGINS.flatMap((plugin) =>
        plugin.platforms.map((id) => ({ kind: 'platform', id })),
      ),
      load: () => undefined,
    },
  ];
}

export function composePlatformPlugins(
  platforms: ProviderRegistry['platforms'],
  inventory: readonly PluginInventoryEntry[],
  assertPluginSelectionCurrent?: (packageName: string) => void,
): PlatformModuleSelection {
  function selectedClaim(family: Platform) {
    const expected = getOptionalPlatformPluginDeclaration(family)?.package;
    return (
      inventory.find((entry) => entry.platform === family) ??
      inventory.find(
        (entry) =>
          expected !== undefined &&
          entry.package === expected &&
          entry.state === 'failed' &&
          entry.platform === undefined &&
          entry.provider === undefined &&
          entry.backend === undefined,
      )
    );
  }

  function reportAbsent(family: Platform): AppError {
    const entry = selectedClaim(family);
    if (entry?.state !== 'failed') return missingPlatformPlugin(family);
    const { code, message, ...details } = entry.error;
    return new AppError(code, message, { ...details, family, package: entry.package });
  }

  function assertSelectionCurrent(family: Platform): void {
    if (
      !assertPluginSelectionCurrent ||
      BUILTIN_PLATFORM_PLUGINS.some((plugin) => plugin.platforms.some((owned) => owned === family))
    )
      return;
    const claim = selectedClaim(family);
    if (claim && claim.source !== 'store') return;
    const packageName = claim?.package ?? getOptionalPlatformPluginDeclaration(family)?.package;
    if (packageName) assertPluginSelectionCurrent(packageName);
  }

  const interactors = registerPlatformPluginSet<RuntimePlatformPlugin>(
    [
      ...BUILTIN_PLATFORM_PLUGINS,
      ...platforms.map((platform) => ({
        id: platform.family,
        platforms: [platform.family],
        createInteractor: platform.createInteractor.bind(platform),
        ...(platform.family === 'web' ? { web: platform } : {}),
        ...(platform.family === 'vega' ? { vega: platform } : {}),
        ...(platform.family === 'harmonyos' ? { harmony: platform } : {}),
        ...(platform.family === 'linux' ? { linux: platform } : {}),
      })),
    ],
    reportAbsent,
    assertSelectionCurrent,
  );

  const web: WebPlatformSelection = {
    active: interactors.tryGet('web')?.plugin.web,
    get() {
      const { web } = interactors.get('web').plugin;
      if (!web) throw new TypeError('Web platform registration is missing its operations');
      return web;
    },
  };

  const vega: VegaPlatformSelection = {
    active: interactors.tryGet('vega')?.plugin.vega,
    get() {
      const { vega } = interactors.get('vega').plugin;
      if (!vega) throw new TypeError('Vega platform registration is missing its operations');
      return vega;
    },
  };

  // The HarmonyOS selection's `get()` is the one authority on the family's absence: an uninstalled
  // plugin raises `plugin-not-installed` with its install command, and one that failed to load
  // raises its own error. Doctor's toolchain row reports that outcome instead of probing a
  // toolchain no plugin is there to drive.
  const harmony: HarmonyPlatformSelection = {
    active: interactors.tryGet('harmonyos')?.plugin.harmony,
    get() {
      const { harmony } = interactors.get('harmonyos').plugin;
      if (!harmony)
        throw new TypeError('HarmonyOS platform registration is missing its operations');
      return harmony;
    },
  };

  // The Linux selection's `get()` is the one authority on the family's absence, as HarmonyOS's is:
  // an uninstalled plugin raises `plugin-not-installed` with its install command, and one that failed
  // to load raises its own error. Doctor's toolchain row reports that outcome instead of probing
  // desktop tools no plugin is there to drive.
  const linux: LinuxPlatformSelection = {
    active: interactors.tryGet('linux')?.plugin.linux,
    get() {
      const { linux } = interactors.get('linux').plugin;
      if (!linux) throw new TypeError('Linux platform registration is missing its operations');
      return linux;
    },
  };

  return {
    interactors,
    web,
    vega,
    harmony,
    linux,
    inventoryModules: platforms.map((platform) => platform.inventoryModule),
    runtimeModules: platforms.map((platform) => platform.runtimeModule),
    reportAbsent,
    assertSelectionCurrent,
  };
}
