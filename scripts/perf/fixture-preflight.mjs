// The Android fixture preflight: one `dumpsys package` probe plus the pure parser behind it.
// The perf suite, `scripts/bench-android-automation.mjs`, and the fixture installer's
// post-install check share it.
//
// A dev-client build of the fixture (expo-dev-launcher) ignores the deep links the suites drive,
// so their samples measure nothing and fail later with opaque errors. Check the installed package
// before the first timed sample and name the command that fixes it.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_FIXTURE_APP_ID = 'com.callstack.agentdevicelab';
const DUMPSYS_TIMEOUT_MS = 30_000;
const DUMPSYS_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
// The dev client registers its activities and scheme under this component; a Release fixture
// strips it. Match the component identity, not prose.
const DEV_LAUNCHER_COMPONENT = 'expo.modules.devlauncher';
// `dumpsys package` prints its flag lists as space-separated upper-case tokens:
// `flags=[ ... ]`, `pkgFlags=[ ... ]`, and the `private`-prefixed variants.
const FLAG_LIST_LINE = /^(?:private)?(?:pkg)?[Ff]lags=\[([^\]]*)\]/;

/** Reads the installed/debuggable/dev-client facts out of one `dumpsys package <id>` output. */
export function parseAndroidPackageFacts(dumpsys) {
  const flags = new Set();
  for (const line of dumpsys.split('\n')) {
    const match = FLAG_LIST_LINE.exec(line.trim());
    if (!match) continue;
    for (const token of match[1].split(/\s+/)) if (token) flags.add(token);
  }
  return {
    // An unknown package prints no flag list. A removed-for-user package keeps its record but
    // prints only `installed=false` per user.
    installed: flags.size > 0 && !(/installed=false/.test(dumpsys) && !/installed=true/.test(dumpsys)),
    debuggable: flags.has('DEBUGGABLE'),
    devClient: dumpsys.includes(DEV_LAUNCHER_COMPONENT),
  };
}

/** Returns the one-line reason the package is not a usable Release fixture, or null when it is. */
export function androidReleaseFixtureProblem(facts, { appId, serial }) {
  // The installer only knows the default package; for another id, name the problem alone.
  const fix =
    appId === DEFAULT_FIXTURE_APP_ID
      ? ` Install the Release fixture: pnpm test-app:android:fixture --serial ${serial}`
      : '';
  if (!facts.installed) {
    return `Android fixture preflight: ${appId} is not installed on ${serial}.${fix}`;
  }
  if (facts.debuggable) {
    return `Android fixture preflight: ${appId} on ${serial} is a debuggable build, not the Release fixture.${fix}`;
  }
  if (facts.devClient) {
    return `Android fixture preflight: ${appId} on ${serial} is a dev-client build (expo-dev-launcher), not the Release fixture.${fix}`;
  }
  return null;
}

/** adb from an SDK root, falling back to PATH. The suites do not reimplement SDK discovery. */
export function resolveAdb(environment = process.env) {
  const sdkRoot = environment.ANDROID_HOME?.trim() || environment.ANDROID_SDK_ROOT?.trim();
  const candidate = sdkRoot ? path.join(sdkRoot, 'platform-tools', 'adb') : undefined;
  return candidate && fs.existsSync(candidate) ? candidate : 'adb';
}

/** Throws the one-line problem when the installed package is not the Release fixture. */
export function assertAndroidReleaseFixture({ serial, appId, adb = resolveAdb() }) {
  let dumpsys;
  try {
    dumpsys = execFileSync(adb, ['-s', serial, 'shell', 'dumpsys', 'package', appId], {
      encoding: 'utf8',
      timeout: DUMPSYS_TIMEOUT_MS,
      maxBuffer: DUMPSYS_MAX_BUFFER_BYTES,
    });
  } catch (error) {
    // A failed probe says nothing about the build; report it as one line instead of a stack.
    const reason = error instanceof Error ? error.message.split('\n').filter(Boolean).pop() : '';
    throw new Error(
      `Android fixture preflight: could not read the installed package on ${serial}: ${reason}. ` +
        `Check that adb runs and ${serial} is online, then install the Release fixture: pnpm test-app:android:fixture --serial ${serial}`,
    );
  }
  const problem = androidReleaseFixtureProblem(parseAndroidPackageFacts(dumpsys), {
    appId,
    serial,
  });
  if (problem) throw new Error(problem);
}
