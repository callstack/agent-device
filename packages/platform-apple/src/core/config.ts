export const IOS_BOOT_TIMEOUT_MS = 180_000;

export const IOS_SIMCTL_LIST_TIMEOUT_MS = 60_000;

export const IOS_APP_LAUNCH_TIMEOUT_MS = 60_000;

export const IOS_DEVICECTL_TIMEOUT_MS = 20_000;

export const IOS_DEVICE_INSTALL_TIMEOUT_MS = 120_000;

export const IOS_SIMULATOR_FOCUS_TIMEOUT_MS = 10_000;

export const IOS_SIMULATOR_TERMINATE_TIMEOUT_MS = 15_000;

export const IOS_SIMULATOR_SCREENSHOT_TIMEOUT_MS = 20_000;

// The CoreDevice panel probe runs on the same request budget as the capture it
// precedes, so its budget must stay clearly below that capture's deadline: a
// wedged CoreDevice must not spend the screenshot's own time and trip the
// request-level daemon reset. Measured probe cost is ~0.2s.
export const IOS_APPLE_DISPLAY_PROBE_TIMEOUT_MS = 5_000;

// CoreSimulator can briefly stall while it services the scale lookup immediately
// after a keyboard transition. Keep this bounded below the full capture budget.
export const IOS_SIMULATOR_SCREENSHOT_SCALE_TIMEOUT_MS = 15_000;

export const IOS_RUNNER_SCREENSHOT_COPY_TIMEOUT_MS = 20_000;

export const IOS_SIMULATOR_SCREENSHOT_RETRY_MAX_ATTEMPTS = 5;
export const IOS_SIMULATOR_SCREENSHOT_RETRY_BASE_DELAY_MS = 1_000;
export const IOS_SIMULATOR_SCREENSHOT_RETRY_MAX_DELAY_MS = 5_000;
