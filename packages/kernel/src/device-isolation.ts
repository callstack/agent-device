function normalizeNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveIosSimulatorDeviceSetPath(
  flagValue: string | undefined,
): string | undefined {
  return normalizeNonEmpty(flagValue);
}

export function parseSerialAllowlist(value: string): Set<string> {
  return new Set(
    value
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

export function resolveAndroidSerialAllowlist(
  flagValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> | undefined {
  const configured =
    normalizeNonEmpty(flagValue) ?? normalizeNonEmpty(env.AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST);
  if (!configured) return undefined;
  return parseSerialAllowlist(configured);
}
