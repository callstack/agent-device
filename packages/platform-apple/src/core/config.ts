export const IOS_BOOT_TIMEOUT_MS = 180_000;

export const IOS_SIMCTL_LIST_TIMEOUT_MS = 60_000;

export const IOS_APP_LAUNCH_TIMEOUT_MS = 60_000;

export const IOS_DEVICECTL_TIMEOUT_MS = 20_000;

export const IOS_DEVICE_INSTALL_TIMEOUT_MS = 120_000;

export const IOS_SIMULATOR_FOCUS_TIMEOUT_MS = 10_000;

export const IOS_SIMULATOR_TERMINATE_TIMEOUT_MS = 15_000;

export const IOS_SIMULATOR_SCREENSHOT_TIMEOUT_MS = 20_000;

// CoreSimulator can briefly stall while it services the scale lookup immediately
// after a keyboard transition. Keep this bounded below the full capture budget.
export const IOS_SIMULATOR_SCREENSHOT_SCALE_TIMEOUT_MS = 15_000;

export const IOS_RUNNER_SCREENSHOT_COPY_TIMEOUT_MS = 20_000;

export const IOS_SIMULATOR_SCREENSHOT_RETRY_MAX_ATTEMPTS = 5;
export const IOS_SIMULATOR_SCREENSHOT_RETRY_BASE_DELAY_MS = 1_000;
export const IOS_SIMULATOR_SCREENSHOT_RETRY_MAX_DELAY_MS = 5_000;

/**
 * Ceiling on one Apple toolchain identity probe attempt (`xcodebuild -version`,
 * `xcrun --show-sdk-version`, `sw_vers`, `uname`, …). On a fresh macOS host,
 * Apple's syspolicyd signature scan blocks the very first `xcodebuild`/`xcrun`/
 * large-binary exec after boot for roughly 18 to 19 seconds at 0% CPU; the
 * second exec of the same tool is instant. A budget sized for a warm toolchain
 * (the old 10 s / 5 s split) trips on that cold-start stall and reports a bogus
 * toolchain-probe timeout unrelated to the change under test (#2422).
 *
 * Both toolchain probers read this one value. `snapshot-source/cache-identity.ts`
 * imports it from here; `runner/runner-cache-metadata.ts` reads it through the
 * Apple runner host port instead, because that file sits in every Apple façade's
 * eager import closure and may not add a module to it
 * (`scripts/__tests__/eager-closure-budgets.test.ts`).
 */
export const COLD_TOOLCHAIN_PROBE_TIMEOUT_MS = 30_000;
