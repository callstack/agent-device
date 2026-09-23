import type { CommandFlags, DispatchedCommand } from '@agent-device/contracts/command';
import { assertRecordRuntimeExecution } from '@agent-device/contracts/record-runtime-execution';
import { readDeclaredPlatformExecution } from './platform-execution-entry.ts';
import type { PostActionObservationSupport } from './post-action-observation.ts';
import { DEFAULT_TIMEOUT_POLICY } from './timeout-policy.ts';
import type {
  CommandCatalogGroup,
  CommandDescriptor,
  CommandFrameworkTier,
  CommandResponseDataTransform,
  CommandTimeoutPolicy,
  DeviceClaimPolicy,
  RecordingEffect,
  TargetIdentityVerification,
} from './types.ts';
import { ownerFilesEnabled, type RawCommandDescriptor } from './descriptor-traits.ts';
import { INTERNAL_COMMAND_DESCRIPTORS } from './descriptors/internal.ts';
import { MANAGEMENT_COMMAND_DESCRIPTORS } from './descriptors/management.ts';
import { OBSERVABILITY_COMMAND_DESCRIPTORS } from './descriptors/observability.ts';
import { RECORDING_COMMAND_DESCRIPTORS } from './descriptors/recording.ts';
import { REPLAY_COMMAND_DESCRIPTORS } from './descriptors/replay.ts';
import { SYSTEM_COMMAND_DESCRIPTORS } from './descriptors/system.ts';
import { CAPTURE_COMMAND_DESCRIPTORS } from './descriptors/capture.ts';
import { INTERACTION_COMMAND_DESCRIPTORS } from './descriptors/interaction.ts';
import { REACT_NATIVE_COMMAND_DESCRIPTORS } from './descriptors/react-native.ts';
import { LOCAL_CLI_COMMAND_DESCRIPTORS } from './descriptors/local-cli.ts';

type RawCommandCatalogGroup<T> = T extends { catalog: { group: infer Group } } ? Group : never;

type RawCommandCatalogKey<T> = T extends { catalog: { key: infer Key extends string } }
  ? Key
  : T extends { name: infer Name extends string }
    ? Name
    : never;

export type DescriptorCommandNameForCatalogGroup<Group extends CommandCatalogGroup> =
  Extract<(typeof commandDescriptors)[number], { name: string }> extends infer Descriptor
    ? Descriptor extends { name: infer Name extends string }
      ? RawCommandCatalogGroup<Descriptor> extends Group
        ? Name
        : never
      : never
    : never;

export type DescriptorCliCommandName =
  | DescriptorCommandNameForCatalogGroup<'public'>
  | DescriptorCommandNameForCatalogGroup<'local-cli'>;

export type DescriptorCatalogRecord<Group extends CommandCatalogGroup> = {
  readonly [
    Descriptor in Extract<
      (typeof commandDescriptors)[number],
      { name: string }
    > as RawCommandCatalogGroup<Descriptor> extends Group ? RawCommandCatalogKey<Descriptor> : never
  ]: Descriptor['name'];
};

/**
 * The literal union of every command whose `daemon.route` is `'session'`.
 * Drives `SESSION_COMMAND_HANDLER_IMPLS` in `src/daemon/handlers/session.ts`: adding a
 * session-routed descriptor without a matching handler table entry is a compile error rather
 * than a runtime routing gap caught only by `expectHandlerResponse`.
 */
export type DescriptorSessionRouteCommandName =
  Extract<
    (typeof commandDescriptors)[number],
    { daemon: { route: 'session' } }
  > extends infer Descriptor
    ? Descriptor extends { name: infer Name extends string }
      ? Name
      : never
    : never;

/**
 * The literal union of every command the daemon routes. A command that never reaches a
 * daemon route cannot be the target of a request, so this is the type a caller building
 * one must name — an unregistered or CLI-only target is a compile error rather than a
 * string the receiver rejects at runtime.
 */
export type DescriptorDaemonRouteCommandName =
  Extract<(typeof commandDescriptors)[number], { daemon: object }> extends infer Descriptor
    ? Descriptor extends { name: infer Name extends string }
      ? Name
      : never
    : never;

// ---------------------------------------------------------------------------
// The command declaration root (ADR 0008). Each entry carries the command identity
// facets plus whichever daemon, batch, MCP, timeout, observation, and
// platform-dispatch traits that command owns. Public catalog identity and the
// non-public dispatch aliases live here too; every view derives from this
// array rather than recreating command-name sets.
// ---------------------------------------------------------------------------
export const RAW_COMMAND_DESCRIPTORS = [
  ...INTERNAL_COMMAND_DESCRIPTORS,
  ...MANAGEMENT_COMMAND_DESCRIPTORS,
  ...OBSERVABILITY_COMMAND_DESCRIPTORS,
  ...RECORDING_COMMAND_DESCRIPTORS,
  ...REPLAY_COMMAND_DESCRIPTORS,
  ...SYSTEM_COMMAND_DESCRIPTORS,
  ...CAPTURE_COMMAND_DESCRIPTORS,
  ...INTERACTION_COMMAND_DESCRIPTORS,
  ...REACT_NATIVE_COMMAND_DESCRIPTORS,
  ...LOCAL_CLI_COMMAND_DESCRIPTORS,
] as const satisfies readonly RawCommandDescriptor[];

/**
 * Compile-time owner-claim totality. `keyof` on a union contains only keys
 * shared by every member, so removing `ownerFiles` from any raw descriptor
 * makes this resolve to `false` and fail the `AssertTrue` constraint.
 */
type AssertTrue<T extends true> = T;
/** Exported only so `noUnusedLocals` keeps the guard alive. */
export type CommandOwnerFileClaimsAreComplete = AssertTrue<
  'ownerFiles' extends keyof (typeof RAW_COMMAND_DESCRIPTORS)[number] ? true : false
>;

const CLI_CATALOG_GROUPS = new Set<CommandCatalogGroup>(['public', 'local-cli']);

const CLI_COMMAND_NAMES = new Set<string>(
  RAW_COMMAND_DESCRIPTORS.filter((descriptor) =>
    CLI_CATALOG_GROUPS.has(readCatalogGroup(descriptor)),
  ).map((descriptor) => descriptor.name),
);

/**
 * {@link RAW_COMMAND_DESCRIPTORS} normalized: `mcpExposed` and `platformExecution`
 * resolved, `ownerFiles` kept out of the runtime shape. The raw array is the root every
 * projection folds over, directly or through this normalized copy — `CLI_COMMAND_NAMES`
 * and the MCP exposure list here, `COMMAND_OWNER_FILES` in `owner-files.ts`, the catalog
 * records, the daemon registry and batch allowlist in their own modules, and the
 * {@link COMMAND_DESCRIPTOR_BY_NAME}, {@link TIMEOUT_POLICY_BY_COMMAND},
 * {@link DEVICE_CLAIM_POLICY_BY_COMMAND} and {@link RESPONSE_DATA_TRANSFORM_BY_COMMAND}
 * maps below. Those four are keyed by `name`, so a duplicated entry collapses into one
 * rather than conflicting.
 *
 * None of those has an independent table left to be byte-equal against: each consumer
 * list became a projection of this array and its hand-authored source went away with it —
 * `47abc8c416` (#907) daemon routes, `96bc7b190c` (#908) capability matrix (retired
 * outright by `ea1d6b8c55` #2089), `607883d66c` (#909) batch allowlist, `8ef4e73408`
 * (#1137) MCP exposure. The test that proved those equivalences is now an invariants-only
 * guard at `src/__tests__/command-descriptor-parity.test.ts` (`2ec4e91b11` #2348).
 *
 * Two kinds of check replace that gate. Required traits are typed: `as const satisfies
 * readonly RawCommandDescriptor[]` on the raw array, `satisfies readonly
 * CommandDescriptor[]` here, and {@link CommandOwnerFileClaimsAreComplete} for owner
 * claims. Classifications are pinned as literal command-name lists, so reclassifying or
 * renaming a command they name means editing that list in the same diff: the device-claim
 * deviating set in
 * `packages/command-registry/src/__tests__/device-claim-policy.test.ts`; the timeout
 * envelopes and budgets in `src/__tests__/command-descriptor-timeout-policy.test.ts` (a
 * declared trait since `b25ef7b024` #1084); and the `targetIdentityVerification` and
 * `'core'` tier sets, plus the tier-iff-public rule, in
 * `src/__tests__/command-descriptor-parity.test.ts`. A duplicated entry is caught by the
 * list comparisons in `packages/command-registry/src/__tests__/owner-files.test.ts` and
 * that parity test.
 *
 * The `as const` on {@link RAW_COMMAND_DESCRIPTORS} flows through this `.map`, so each
 * entry keeps its literal `name`. That is what makes the {@link Command} union below a
 * precise set of command-name literals rather than `string`.
 */
export const commandDescriptors = RAW_COMMAND_DESCRIPTORS.map((descriptor) => {
  const platformExecution = readDeclaredPlatformExecution(descriptor);
  if (descriptor.name === 'record') assertRecordRuntimeExecution(platformExecution);
  if (!ownerFilesEnabled) {
    return {
      ...descriptor,
      mcpExposed: resolveMcpExposure(descriptor),
      platformExecution,
    };
  }

  const { ownerFiles: _, ...runtimeDescriptor } = descriptor;
  return {
    ...runtimeDescriptor,
    mcpExposed: resolveMcpExposure(descriptor),
    platformExecution,
  };
}) satisfies readonly CommandDescriptor[];

/** The literal union of every registered command name. */
export type Command = (typeof commandDescriptors)[number]['name'];

/**
 * @internal Command names for one catalog group, sorted.
 *
 * Consumed only by `src/__tests__/command-descriptor-parity.test.ts`, which compares
 * these names against the `PUBLIC_COMMANDS` / `INTERNAL_COMMANDS` records `catalog.ts`
 * builds from {@link listDescriptorCatalogEntries}: a duplicated descriptor or a
 * colliding `catalog.key` drops a name from one side of that comparison. Production code
 * reads those records; this flat list is the second side the test checks them against,
 * which is why the helper stays exported.
 */
export function listDescriptorCatalogCommandNames<Group extends CommandCatalogGroup>(
  group: Group,
): Array<DescriptorCommandNameForCatalogGroup<Group>> {
  return listDescriptorCatalogEntries(group)
    .map(([, name]) => name)
    .sort();
}

export function listDescriptorCatalogEntries<Group extends CommandCatalogGroup>(
  group: Group,
): Array<readonly [key: string, name: DescriptorCommandNameForCatalogGroup<Group>]> {
  return commandDescriptors
    .filter((descriptor) => readCatalogGroup(descriptor) === group)
    .map(
      (descriptor) =>
        [
          readCatalogKey(descriptor),
          descriptor.name as DescriptorCommandNameForCatalogGroup<Group>,
        ] as const,
    );
}

export function listMcpExposedCommandNames(): DescriptorCliCommandName[] {
  return commandDescriptors
    .filter((descriptor) => isMcpExposedCliCommand(descriptor))
    .map((descriptor) => descriptor.name as DescriptorCliCommandName)
    .sort();
}

export function commandRuntimeUseRequirements(
  command: string,
): readonly (readonly string[])[] | undefined {
  const descriptor = commandDescriptors.find((candidate) => candidate.name === command);
  const execution = descriptor?.platformExecution;
  if (execution?.kind !== 'device-runtime') return undefined;
  const uses = 'uses' in execution ? execution.uses : [execution.use];
  return uses.map((use) => use.required);
}

export function listRuntimeFactCommands(): string[] {
  return commandDescriptors
    .filter(
      (descriptor) =>
        descriptor.catalog.group === 'public' &&
        descriptor.platformExecution.kind === 'device-runtime',
    )
    .map((descriptor) => descriptor.name)
    .sort();
}

const COMMAND_DESCRIPTOR_BY_NAME: ReadonlyMap<string, CommandDescriptor> = new Map(
  commandDescriptors.map((descriptor) => [descriptor.name, descriptor]),
);

function isCliCommandName(command: string): command is DescriptorCliCommandName {
  return CLI_COMMAND_NAMES.has(command);
}

function resolveMcpExposure(descriptor: RawCommandDescriptor): boolean {
  return descriptor.mcpExposed ?? CLI_COMMAND_NAMES.has(descriptor.name);
}

function isMcpExposedCliCommand(descriptor: CommandDescriptor): boolean {
  return descriptor.mcpExposed && isCliCommandName(descriptor.name);
}

function readCatalogGroup(descriptor: {
  name: string;
  catalog: { group: CommandCatalogGroup; key?: string };
}): CommandCatalogGroup {
  return descriptor.catalog.group;
}

function readCatalogKey(descriptor: {
  name: string;
  catalog: { group: CommandCatalogGroup; key?: string };
}): string {
  return descriptor.catalog.key ?? descriptor.name;
}

const TIMEOUT_POLICY_BY_COMMAND: ReadonlyMap<string, CommandTimeoutPolicy> = new Map(
  commandDescriptors.map((descriptor) => [descriptor.name, descriptor.timeoutPolicy]),
);

const DEVICE_CLAIM_POLICY_BY_COMMAND: ReadonlyMap<string, DeviceClaimPolicy> = new Map(
  commandDescriptors.map((descriptor) => [descriptor.name, descriptor.deviceClaimPolicy]),
);

const RESPONSE_DATA_TRANSFORM_BY_COMMAND: ReadonlyMap<string, CommandResponseDataTransform> =
  new Map(
    Array.from(COMMAND_DESCRIPTOR_BY_NAME.values()).flatMap((descriptor) =>
      descriptor.responseDataTransform
        ? [[descriptor.name, descriptor.responseDataTransform] as const]
        : [],
    ),
  );

export function resolveCommandPostActionObservationSupport(
  command: string | undefined,
): PostActionObservationSupport | undefined {
  if (command === undefined) return undefined;
  return COMMAND_DESCRIPTOR_BY_NAME.get(command)?.postActionObservation;
}

export function commandSupportsSettleObservation(command: string | undefined): boolean {
  return resolveCommandPostActionObservationSupport(command) !== undefined;
}

export function commandSupportsVerifyEvidence(command: string | undefined): boolean {
  return resolveCommandPostActionObservationSupport(command) === 'settle-and-verify';
}

/**
 * The declared timeout policy for a command (ADR 0008). Command names outside
 * the registry (internal probes, unknown commands) fall back to
 * {@link DEFAULT_TIMEOUT_POLICY} — standard envelope, reset-daemon — exactly as
 * the deleted hand lists treated unlisted commands.
 */
export function resolveCommandTimeoutPolicy(command: string | undefined): CommandTimeoutPolicy {
  if (command === undefined) return DEFAULT_TIMEOUT_POLICY;
  return TIMEOUT_POLICY_BY_COMMAND.get(command) ?? DEFAULT_TIMEOUT_POLICY;
}

/**
 * The declared #1320 device-claim policy for a command. Names outside the
 * registry (internal probes, unknown commands) resolve to `require-owner`: the
 * value that performs no claim-store I/O at the binding seam, so an
 * unregistered name can neither acquire nor be refused a claim.
 */
export function resolveCommandDeviceClaimPolicy(command: string | undefined): DeviceClaimPolicy {
  if (command === undefined) return 'require-owner';
  return DEVICE_CLAIM_POLICY_BY_COMMAND.get(command) ?? 'require-owner';
}

export function resolveCommandResponseDataTransform(
  command: string | undefined,
): CommandResponseDataTransform | undefined {
  if (command === undefined) return undefined;
  return RESPONSE_DATA_TRANSFORM_BY_COMMAND.get(command);
}

export function resolveCommandRecordsSessionAction(command: string | undefined): boolean {
  if (command === undefined) return false;
  return COMMAND_DESCRIPTOR_BY_NAME.get(command)?.recordsSessionAction ?? false;
}

/**
 * The declared {@link CommandFrameworkTier} for a public command, or
 * `undefined` for a command that never declares one. A tier is declared iff
 * `catalog.group === 'public'`; that rule is a runtime pin, not a type rule —
 * `src/__tests__/command-descriptor-parity.test.ts` asserts it and the exact
 * `'core'` tool set, so a new public command cannot join a framework adapter's
 * default set silently. Framework adapters (`agent-device/ai-sdk`,
 * `@agent-device/eve`) read this to build their default tool set instead of
 * hand-listing tool names.
 */
export function resolveCommandFrameworkTier(
  command: string | undefined,
): CommandFrameworkTier | undefined {
  if (command === undefined) return undefined;
  return COMMAND_DESCRIPTOR_BY_NAME.get(command)?.frameworkTier;
}

/**
 * ADR 0012 / #1349: the replay verification phase for one command's recorded
 * `target-v1` evidence, or `undefined` for a command whose steps never carry
 * it (an annotation on such a step is inert, exactly like an old reader).
 */
export function resolveTargetIdentityVerification(
  command: string,
): TargetIdentityVerification | undefined {
  return COMMAND_DESCRIPTOR_BY_NAME.get(command)?.targetIdentityVerification;
}

/** ADR 0016 request-sensitive app-state effect for one recorded request. */
export function resolveCommandRecordingEffect(req: DispatchedCommand): RecordingEffect | undefined {
  const descriptor = COMMAND_DESCRIPTOR_BY_NAME.get(req.command);
  if (!descriptor?.recordsSessionAction) return undefined;
  return typeof descriptor.recordingEffect === 'function'
    ? descriptor.recordingEffect(req)
    : descriptor.recordingEffect;
}

/**
 * @internal The commands that declare a {@link CommandResponseDataTransform}, with it.
 *
 * Consumed only by `src/commands/__tests__/command-surface-metadata.test.ts`, which
 * checks every transform field against that command's declared input schema. The
 * production projection of the same map is
 * {@link listCommandResponseDataTransformFieldNames}.
 */
export function listCommandResponseDataTransforms(): Array<{
  command: string;
  transform: CommandResponseDataTransform;
}> {
  return Array.from(RESPONSE_DATA_TRANSFORM_BY_COMMAND, ([command, transform]) => ({
    command,
    transform,
  }));
}

export function listCommandResponseDataTransformFieldNames(): string[] {
  return [
    ...new Set(
      Array.from(RESPONSE_DATA_TRANSFORM_BY_COMMAND.values()).flatMap((transform) =>
        Object.keys(transform.fields),
      ),
    ),
  ].sort();
}

// The flag values a command applies when the caller omits them — the single source for both the
// CLI parser and the daemon request scope. It lives in the registry (not a command facet, not a
// new module) because the registry is already in both callers' eager closure and declares every
// other command default here as a literal (see the `defaultValue` descriptors above).
const COMMAND_DEFAULTS: Partial<Record<DescriptorCliCommandName, Partial<CommandFlags>>> = {
  apps: { appsFilter: 'user-installed' },
};

export function applyCommandDefaults(
  command: string | null,
  flags: Record<string, unknown>,
): boolean {
  if (!command || !isCliCommandName(command)) return false;
  const defaults = COMMAND_DEFAULTS[command];
  if (!defaults) return false;
  let changed = false;
  for (const key of Object.keys(defaults) as Array<keyof CommandFlags>) {
    if (flags[key] === undefined) {
      flags[key] = defaults[key];
      changed = true;
    }
  }
  return changed;
}
