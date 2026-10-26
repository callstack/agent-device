export const IOS_BOOT_TIMEOUT_MS = 180_000;

export const IOS_SIMCTL_LIST_TIMEOUT_MS = 60_000;

export const IOS_APP_LAUNCH_TIMEOUT_MS = 60_000;

export const IOS_DEVICECTL_TIMEOUT_MS = 20_000;
/** The smallest `--timeout` in seconds devicectl accepts; smaller values exit 64 before querying. */
export const IOS_DEVICECTL_MIN_TIMEOUT_SECONDS = 5;

export const IOS_DEVICE_INSTALL_TIMEOUT_MS = 120_000;

export const IOS_SIMULATOR_SHOW_TIMEOUT_MS = 10_000;

export const IOS_SIMULATOR_TERMINATE_TIMEOUT_MS = 15_000;

/**
 * How long a Simulator `simctl openurl` may take. CoreSimulator can hold an URL hand-off for
 * minutes while it is wedged, and every other simctl call this open makes is bounded; the bound
 * stays well under the daemon request budget so the open answers with its own typed reason and
 * kills the child instead of being cancelled around a still-running `openurl`.
 */
export const IOS_SIMULATOR_OPENURL_TIMEOUT_MS = 20_000;

export const IOS_SIMULATOR_SCREENSHOT_TIMEOUT_MS = 20_000;

// The CoreDevice panel probe runs on the same request budget as the capture it
// precedes, so its budget must stay clearly below that capture's deadline: a
// wedged CoreDevice must not spend the screenshot's own time and trip the
// request-level daemon reset. Measured probe cost is ~0.2s.
export const IOS_APPLE_DISPLAY_PROBE_TIMEOUT_MS = 5_000;
/**
 * A scoped simulator's panel table comes from a guest helper that the first read on a host also
 * builds. This ceiling on the whole read, build included, stays below the capture's own budget.
 */
export const IOS_SCOPED_DISPLAY_PROBE_BUDGET_MS = 15_000;
/**
 * One guest hinge read, before its sampling window: the fold helper waits at most 3s for its first
 * CoreMotion sample, so this exec deadline only guards a wedged `simctl spawn`.
 */
export const IOS_HINGE_ANGLE_READ_TIMEOUT_MS = 4_000;
/**
 * How many hinge reads a dispatched hinge request gets to reach its pose before the pose is refused.
 * With the window below, the settle budget is about 9 seconds of hinge observation. The fold request
 * envelope (`FOLD_REQUEST_TIMEOUT_MS`) covers this budget's worst case, so raise them together.
 */
export const IOS_FOLD_POSE_SETTLE_ATTEMPTS = 8;
/**
 * The sampling window of every hinge read after the first. A guest read otherwise returns in about
 * 0.3s, so without a deliberate gap two reads of a moving hinge could land close enough together to
 * look settled. The helper spends the window inside the simulator and reports its latest sample.
 */
export const IOS_FOLD_POSE_READ_INTERVAL_MS = 1_000;
/** Two consecutive reads this close together mean the hinge has stopped moving. */
export const IOS_FOLD_POSE_STABLE_DEGREES = 0.5;

// CoreSimulator can briefly stall while it services the scale lookup immediately
// after a keyboard transition. Keep this bounded below the full capture budget.
export const IOS_SIMULATOR_SCREENSHOT_SCALE_TIMEOUT_MS = 15_000;

export const IOS_RUNNER_SCREENSHOT_COPY_TIMEOUT_MS = 20_000;

export const IOS_SIMULATOR_SCREENSHOT_RETRY_MAX_ATTEMPTS = 5;
export const IOS_SIMULATOR_SCREENSHOT_RETRY_BASE_DELAY_MS = 1_000;
export const IOS_SIMULATOR_SCREENSHOT_RETRY_MAX_DELAY_MS = 5_000;
