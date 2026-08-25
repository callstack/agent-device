/**
 * Whether an adb `cmd clipboard` invocation was refused because this Android build ships no shell
 * implementation for the clipboard service, rather than because the call itself failed.
 *
 * Shared so admission and execution decide identically: `packages/platform-android` probes with it
 * when generating facts, and the root clipboard leaf re-checks with it as defense in depth. Two
 * copies of this predicate could drift into a device that `capabilities` advertises and execution
 * refuses, which is exactly the split ADR 0019 §2 forbids.
 *
 * It reads adb's own output because adb reports this condition in no other way: there is no exit
 * code or structured field that distinguishes "service has no shell command" from any other
 * non-zero result.
 */
export function isAndroidClipboardShellUnsupported(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`.toLowerCase();
  return (
    haystack.includes('no shell command implementation') || haystack.includes('unknown command')
  );
}
