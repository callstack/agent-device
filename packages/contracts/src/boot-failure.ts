const INFRASTRUCTURE_BOOT_FAILURE_REASONS = [
  'IOS_BOOT_TIMEOUT',
  'IOS_RUNNER_CONNECT_TIMEOUT',
  'IOS_RUNNER_OWNED_BY_OTHER_DAEMON',
  'IOS_TOOL_MISSING',
  'ANDROID_BOOT_TIMEOUT',
  'ADB_TRANSPORT_UNAVAILABLE',
  'CI_RESOURCE_STARVATION_SUSPECTED',
] as const;

export type InfrastructureBootFailureReason = (typeof INFRASTRUCTURE_BOOT_FAILURE_REASONS)[number];

const infrastructureBootFailureReasons: ReadonlySet<InfrastructureBootFailureReason> = new Set(
  INFRASTRUCTURE_BOOT_FAILURE_REASONS,
);

/** True when a boot failure can be retried by changing host/transport conditions. */
export function isInfrastructureBootFailureReason(
  reason: string,
): reason is InfrastructureBootFailureReason {
  return infrastructureBootFailureReasons.has(
    reason.toUpperCase() as InfrastructureBootFailureReason,
  );
}
