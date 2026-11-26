// Type surface for the fixture preflight (it must stay runnable by bare `node`, like the bench
// harness that imports it). Keep it in step with the exports of `./fixture-preflight.mjs`.
export type AndroidPackageFacts = {
  installed: boolean;
  debuggable: boolean;
  devClient: boolean;
};

export function parseAndroidPackageFacts(dumpsys: string): AndroidPackageFacts;

export function androidReleaseFixtureProblem(
  facts: AndroidPackageFacts,
  ids: { appId: string; serial: string },
): string | null;

export function resolveAdb(environment?: NodeJS.ProcessEnv): string;

export function assertAndroidReleaseFixture(ids: {
  serial: string;
  appId: string;
  adb?: string;
}): void;
