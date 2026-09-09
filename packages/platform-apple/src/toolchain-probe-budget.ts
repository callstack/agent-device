/**
 * Per-call timeout for a toolchain identity probe (`xcodebuild -version`,
 * `xcrun --show-sdk-version`, `sw_vers`, `uname`, …). On a fresh macOS host,
 * Apple's syspolicyd signature scan blocks the very first `xcodebuild`/
 * `xcrun`/large-binary exec after boot for roughly 18 to 19 seconds at 0%
 * CPU; the second exec of the same tool is instant. A budget sized for a
 * warm toolchain (the old 10 s / 5 s split) trips on that cold-start stall
 * and reports a bogus toolchain-probe timeout unrelated to the change under
 * test (#2422).
 *
 * `snapshot-source/cache-identity.ts` and `runner/runner-cache-metadata.ts`
 * both read this one constant for their per-call budget, and both retry
 * once after a timeout while their deadline still allows it, so the two
 * budgets cannot drift apart again.
 */
export const COLD_TOOLCHAIN_PROBE_TIMEOUT_MS = 30_000;
