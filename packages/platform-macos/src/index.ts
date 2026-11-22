import type { MacOsPlatformLeafContribution, PlatformHost } from 'agent-device/plugins';
import type {
  MacOsLeafOperations,
  MacOsLeafTools,
  MacOsPlatformLeafRegistration,
} from '@agent-device/contracts/macos-platform-leaf';
import type { MacOsToolbox } from './toolbox.ts';

/**
 * The implementation modules, each resolved exactly once per process. The façade must stay
 * metadata-eager (ADR 0019), so a module enters with the first operation that needs it. Only the
 * modules are memoized: each `bind` carries its own host and tools.
 */
let appsModule: Promise<typeof import('./apps.ts')> | undefined;
const loadApps = () => (appsModule ??= import('./apps.ts'));

let helperModule: Promise<typeof import('./helper.ts')> | undefined;
const loadHelper = () => (helperModule ??= import('./helper.ts'));

let runnerCommandsModule: Promise<typeof import('./runner-commands.ts')> | undefined;
const loadRunnerCommands = () => (runnerCommandsModule ??= import('./runner-commands.ts'));

/** Every macOS operation the Apple owner delegates, bound to one request's tools. */
function bindMacOsOperations(box: MacOsToolbox): MacOsLeafOperations {
  return Object.freeze({
    resolveApp: async (app) => await (await loadApps()).resolveMacOsApp(box, app),
    resolveAppDeviceOpenTarget: async (device, target) =>
      await (await loadApps()).resolveMacOsAppDeviceOpenTarget(box, device, target),
    openApp: async (device, app, options) =>
      await (await loadApps()).openMacOsApp(box, device, app, options),
    closeApp: async (device, app, env) =>
      await (await loadApps()).closeMacOsApp(box, device, app, env),
    listApps: async (filter) => await (await loadApps()).listMacApps(box, filter),
    readClipboardText: async () => await (await loadApps()).readMacOsClipboardText(box),
    writeClipboardText: async (text) => await (await loadApps()).writeMacOsClipboardText(box, text),
    setAppearance: async (state) => await (await loadApps()).setMacOsAppearance(box, state),
    frontmostApp: async (env) => await (await loadHelper()).resolveFrontmostMacOsApp(box, env),
    runPermissionAction: async (action, target, env) =>
      await (await loadHelper()).runMacOsPermissionAction(box, action, target, env),
    runAlertAction: async (action, options) =>
      await (await loadHelper()).runMacOsAlertAction(box, action, options),
    readTextAtPoint: async (x, y, options) =>
      await (await loadHelper()).runMacOsReadTextAction(box, x, y, options),
    press: async (x, y, options) =>
      await (await loadHelper()).runMacOsPressAction(box, x, y, options),
    screenshot: async (outPath, options) =>
      await (await loadHelper()).runMacOsScreenshotAction(box, outPath, options),
    captureSurfaceSnapshot: async (options, signal, env) => {
      const { captureMacOsSurfaceSnapshot } = await import('./surface-snapshot.ts');
      return await captureMacOsSurfaceSnapshot(box, options, signal, env);
    },
    startAudioProbe: async (options) =>
      await (await loadHelper()).startMacOsAudioProbeProcess(box, options),
    nativeAppActions: async (base, context, env) => {
      const { macOsNativeAppActions } = await import('./native-app-actions.ts');
      return macOsNativeAppActions(box, base, context, env);
    },
    nativeBackendFacts: async () =>
      (await import('./native-backend-facts.ts')).MACOS_NATIVE_BACKEND_FACTS,
    desktopScroll: async (runner, context, runnerOptions, direction, options) =>
      await (
        await loadRunnerCommands()
      ).runMacOsDesktopScroll(runner, context, runnerOptions, direction, options),
    alternateClick: async (runner, context, runnerOptions, point, button) =>
      await (
        await loadRunnerCommands()
      ).runMacOsAlternateClick(runner, context, runnerOptions, point, button),
  } satisfies MacOsLeafOperations);
}

function macOsPlatformPlugin() {
  return {
    apiVersion: 3,
    contributes: [
      {
        kind: 'platform',
        family: 'apple',
        appleOs: 'macos',
        // The leaf registers no family module: the bundled Apple owner keeps the `apple` claim and
        // calls what `bind` returns at its macOS branches. Importing this package evaluates nothing
        // but itself, and `setup` starts no process and builds no helper.
        setup(host: PlatformHost): MacOsPlatformLeafRegistration {
          return {
            family: 'apple',
            appleOs: 'macos',
            bind: (tools: MacOsLeafTools) => bindMacOsOperations({ host, tools }),
          };
        },
      },
    ],
  } satisfies { apiVersion: 3; contributes: [MacOsPlatformLeafContribution] };
}

export { macOsPlatformPlugin as default };
