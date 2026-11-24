/**
 * One row of `launchctl list` inside a simulator (`PID Status Label`), with `pid` undefined for a
 * job that has no process, which launchctl prints as `-`.
 */
export type LaunchctlJob = { label: string; pid: number | undefined };

export function readLaunchctlJobs(output: string): LaunchctlJob[] {
  return output.split('\n').flatMap((line) => {
    const [pidText, , label] = line.trim().split(/\s+/);
    if (!pidText || !label) return [];
    const pid = Number(pidText);
    return [{ label, pid: Number.isSafeInteger(pid) && pid > 0 ? pid : undefined }];
  });
}

const UIKIT_APPLICATION_LABEL = /^UIKitApplication:([^[\s]+)\[/;

/** The bundle id a `UIKitApplication:<bundle id>[…]` job label names. */
export function uiKitApplicationBundleId(label: string): string | undefined {
  return UIKIT_APPLICATION_LABEL.exec(label)?.[1];
}
