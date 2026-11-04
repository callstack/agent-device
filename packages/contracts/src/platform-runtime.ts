import { scryptSync } from 'node:crypto';
import {
  isPlatform,
  type AppleOS,
  type DeviceInfo,
  type DeviceKind,
  type DeviceTarget,
  type Platform,
} from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { PlatformModuleMetadata } from './platform-module.ts';
import type { PlatformRequestScope } from './platform-runtime-host.ts';
import type { ApplicationLifecycleResourceLifecycle } from './application-lifecycle-runtime.ts';
import { invalidRuntimeContract } from './runtime-contract-error.ts';

type RuntimeOperation = (...args: never[]) => unknown;

/** String keys whose catalog entries are concrete semantic operation functions. */
export type RuntimeOperationKey<Operations extends object> = Extract<
  {
    [Key in keyof Operations]: Operations[Key] extends RuntimeOperation ? Key : never;
  }[keyof Operations],
  string
>;

declare const runtimeOperations: unique symbol;

export type RuntimeUseDeclaration = Readonly<{
  required: readonly string[];
  preferred: readonly string[];
  conditional?: readonly string[];
}>;

export type RuntimeUse<
  Operations extends object,
  Required extends readonly RuntimeOperationKey<Operations>[],
  Preferred extends readonly Exclude<RuntimeOperationKey<Operations>, Required[number]>[],
  Conditional extends readonly Exclude<
    RuntimeOperationKey<Operations>,
    Required[number] | Preferred[number]
  >[],
> = RuntimeUseDeclaration &
  Readonly<{
    required: Required;
    preferred: Preferred;
    conditional?: Conditional;
    /** Type-only link to the operation catalog; never emitted in descriptor metadata. */
    readonly [runtimeOperations]?: Operations;
  }>;

export type RuntimeOwnerRef =
  | Readonly<{ kind: 'local-family'; family: Platform }>
  | Readonly<{ kind: 'provider-runtime'; provider: string; instance: string }>;

export function localRuntimeOwner(family: Platform): RuntimeOwnerRef {
  if (!isPlatform(family)) {
    throw new TypeError(`Unknown local runtime family: ${String(family)}`);
  }
  return Object.freeze({ kind: 'local-family', family });
}

export function providerRuntimeOwner(
  provider: string,
  instance: string,
): Extract<RuntimeOwnerRef, { kind: 'provider-runtime' }> {
  const normalizedProvider = provider.trim();
  const normalizedInstance = instance.trim();
  if (normalizedProvider.length === 0 || normalizedInstance.length === 0) {
    throw new TypeError(
      'Provider runtime owner requires non-empty provider and instance identities',
    );
  }
  return Object.freeze({
    kind: 'provider-runtime',
    provider: normalizedProvider,
    instance: normalizedInstance,
  });
}

// The key length and the scrypt cost, block size and parallelism all feed the digest: changing any of
// them re-identifies every derived instance (`maxmem` is only a cap). An instance a composition names
// outright, such as Limrun's `runtimeInstance` option, is not derived here at all. For a provider that
// writes its instance into durable state, such as Limrun's app-log descriptors, a change orphans every
// such resource; Revyl keeps its instance in-process only. Each provider pins its own digest through
// the wrapper that builds its principal.
const RUNTIME_INSTANCE_KEY_LENGTH_BYTES = 32;
const RUNTIME_INSTANCE_SCRYPT_COST = 16_384;
const RUNTIME_INSTANCE_SCRYPT_BLOCK_SIZE = 8;
const RUNTIME_INSTANCE_SCRYPT_PARALLELISM = 1;
const RUNTIME_INSTANCE_SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

/**
 * One fact of a provider principal: its name, and its value, or `undefined` when this account has
 * none. An unset fact is left out of the digest, exactly as an absent one.
 */
export type ProviderRuntimePrincipalField = readonly [name: string, value: string | undefined];

/**
 * The runtime-owner instance for one provider account, for `providerRuntimeOwner`. The principal is
 * the ordered list of facts that decide which devices one runtime rents (credentials, region, attached
 * endpoints): two runtimes with the same principal share one owner. It is hashed, not carried,
 * because the instance travels into diagnostics and durable envelopes.
 *
 * The order of the facts is part of the digest, so a provider declares them in one place and pins the
 * result. `provider` is normalized as `providerRuntimeOwner` normalizes it, and the salt derives from
 * it, so one set of credentials is a different instance under another provider.
 *
 * The digest is a synchronous, memory-hard scrypt (about 16 MiB, tens of milliseconds): derive it once
 * when a runtime is built, never on a request path.
 */
export function providerRuntimeInstance(
  provider: string,
  principal: readonly ProviderRuntimePrincipalField[],
): string {
  const normalizedProvider = provider.trim();
  if (normalizedProvider.length === 0) {
    throw new TypeError('Provider runtime instance requires a non-empty provider');
  }
  // No prototype, so a field named `__proto__` is an own key like any other.
  const facts: Record<string, string> = Object.create(null) as Record<string, string>;
  facts.provider = normalizedProvider;
  const names = new Set(['provider']);
  for (const [name, value] of principal) {
    if (name.length === 0 || names.has(name)) {
      throw new TypeError(`Provider runtime principal field '${name}' is empty or repeated`);
    }
    // JSON orders integer-like keys first, which would break the declared field order.
    if (/^\d+$/.test(name)) {
      throw new TypeError(`Provider runtime principal field '${name}' must not be an integer`);
    }
    names.add(name);
    if (value !== undefined) facts[name] = value;
  }
  if (Object.keys(facts).length === 1) {
    throw new TypeError('Provider runtime principal needs at least one fact with a value');
  }
  const fingerprint = scryptSync(
    JSON.stringify(facts),
    `agent-device:${normalizedProvider}-runtime-owner:v1`,
    RUNTIME_INSTANCE_KEY_LENGTH_BYTES,
    {
      N: RUNTIME_INSTANCE_SCRYPT_COST,
      r: RUNTIME_INSTANCE_SCRYPT_BLOCK_SIZE,
      p: RUNTIME_INSTANCE_SCRYPT_PARALLELISM,
      maxmem: RUNTIME_INSTANCE_SCRYPT_MAX_MEMORY,
    },
  );
  return `principal-${fingerprint.toString('hex')}`;
}

export function runtimeOwnerKey(owner: RuntimeOwnerRef): string {
  switch (owner.kind) {
    case 'local-family':
      return `local:${owner.family}`;
    case 'provider-runtime':
      return `provider:${JSON.stringify([owner.provider, owner.instance])}`;
  }
}

export function sameRuntimeOwner(left: RuntimeOwnerRef, right: RuntimeOwnerRef): boolean {
  return runtimeOwnerKey(left) === runtimeOwnerKey(right);
}

export type RuntimeProviderMode = 'local' | 'transport-composed' | 'provider-runtime';

export type RuntimeDeviceShape = Readonly<{
  family: Platform;
  appleOs?: AppleOS;
  kind: DeviceKind;
  target?: DeviceTarget;
  iosPhysicalDeviceBackend?: DeviceInfo['iosPhysicalDeviceBackend'];
  providerMode: RuntimeProviderMode;
}>;

export type RuntimeOperationUnavailability = Readonly<{
  available: false;
  reason:
    | 'unsupported-platform-leaf'
    | 'unsupported-device-kind'
    | 'unsupported-device-backend'
    | 'unsupported-device-scope'
    | 'unsupported-provider-mode'
    | 'owner-capability-missing'
    /**
     * A hosted provider owns the network path for its session, so a live `network dump` has no
     * source to read. Where the provider records traffic at all, it publishes that report only
     * after its own session ends, on the provider's side.
     */
    | 'network-capture-post-session';
  hint?: string;
}>;

type RuntimeSubjectFact = Readonly<{ available: true }> | RuntimeOperationUnavailability;

/**
 * `subjects` names, for an operation an owner serves for only some of its subjects (the settings
 * `setSetting` changes), each subject's own fact; `unlisted` answers for every other subject.
 * Admission checks the requested subject's fact; a bound runtime keeps only `available`.
 */
export type RuntimeOperationFact =
  | Readonly<{
      available: true;
      subjects?: Readonly<Record<string, RuntimeSubjectFact>>;
      unlisted?: RuntimeOperationUnavailability;
    }>
  | RuntimeOperationUnavailability;

const UNLISTED_SUBJECT = unavailableFact('unsupported-platform-leaf');

export function runtimeSubjectFact(
  fact: RuntimeOperationFact,
  subject: string,
): RuntimeSubjectFact {
  if (!fact.available || fact.subjects === undefined) return fact;
  if (Object.hasOwn(fact.subjects, subject)) return fact.subjects[subject]!;
  return fact.unlisted ?? UNLISTED_SUBJECT;
}

/** One frozen unavailable cell; owners list their refusals as calls instead of literals. */
export function unavailableFact(
  reason: RuntimeOperationUnavailability['reason'],
  hint?: string,
): RuntimeOperationUnavailability {
  return Object.freeze(
    hint === undefined ? { available: false, reason } : { available: false, reason, hint },
  );
}

/**
 * An operation is present on a binding only when the owner's own facts admitted it. One helper so
 * every owner's `bind` reads as a list of admitted operations rather than a chain of branches —
 * and so the next operation added there costs no additional branch.
 */
export function whenAdmitted<T extends object>(
  fact: RuntimeOperationFact,
  build: () => T,
): T | Record<string, never> {
  return fact.available ? build() : {};
}

export type RuntimeFacts<Operations extends object> = Readonly<{
  device: RuntimeDeviceShape;
  operations: Readonly<{
    [Key in RuntimeOperationKey<Operations>]: RuntimeOperationFact;
  }>;
}>;

export type DeviceBinding<Operations extends object> = AsyncDisposable &
  Readonly<{
    device: DeviceInfo;
    owner: RuntimeOwnerRef;
    facts: RuntimeFacts<Operations>;
    operations: Readonly<Partial<Pick<Operations, RuntimeOperationKey<Operations>>>>;
    /**
     * Binding construction and disposal leave no work that can outlive the process, and a
     * successful recording stop has drained every effect it dispatched. Scoped or remote backends
     * must not advertise this.
     */
    recordingCleanupRecovery?: 'local-drained';
    /** Resolves only after a failed disposal and all binding-owned work have settled. */
    retryDisposal?: () => Promise<void>;
    recoverIncompleteRecordingStart?: (
      input: Readonly<{ sessionId: string; fence: ResourceOwnershipFence; claimToken: string }>,
    ) => Promise<'confirmed-no-effect' | 'retained'>;
  }>;

export type ResourceOwnershipFence = Readonly<{
  token: string;
  generation: number;
}>;

export type DeviceBindingIntent =
  | Readonly<{ kind: 'ordinary' }>
  | Readonly<{
      kind: 'exact-owner';
      owner: RuntimeOwnerRef;
      fence: ResourceOwnershipFence;
    }>;

export type DeviceBindingRequest = Readonly<{
  device: DeviceInfo;
  intent: DeviceBindingIntent;
  scope: PlatformRequestScope;
}>;

/** Provider-first request gateway. Ordinary and exact-owner selection stay inside this module. */
export type DeviceRuntimeGateway<Operations extends object> = Readonly<{
  inspectFacts(device: DeviceInfo): Promise<RuntimeFacts<Operations>>;
  bind(request: DeviceBindingRequest): Promise<DeviceBinding<Operations>>;
  /**
   * Attempts each owner once; repeated calls share the attempt and the same rejection.
   * Owner failures reject with COMMAND_FAILED and details.reason platform-owner-shutdown-failed;
   * details.failures preserves each owner and error. After shutdown starts, bind and inspectFacts
   * reject with COMMAND_FAILED and details.reason runtime-gateway-shut-down.
   */
  shutdown(): Promise<void>;
  /** Package-coordinated durable lifecycle phases used for startup recovery and daemon shutdown. */
  applicationLifecycle?: ApplicationLifecycleResourceLifecycle;
}>;

/** One selectable local or provider owner; narrow providers do not implement this interface. */
export type DeviceRuntimeOwner<Operations extends object> = DeviceRuntimeGateway<Operations> &
  Readonly<{
    owner: RuntimeOwnerRef;
    ownsDevice(device: DeviceInfo): boolean;
  }>;

/** A family module gains this interface only with an honest package-owned runtime. */
export type RuntimePlatformModule<Operations extends object, Host> = PlatformModuleMetadata &
  Readonly<{
    loadRuntime(host: Host): Promise<DeviceRuntimeOwner<Operations>>;
  }>;

type OperationsOf<Use> =
  Use extends RuntimeUse<infer Operations, infer _Required, infer _Preferred, infer _Conditional>
    ? Operations
    : never;

type RequiredOf<Use> =
  Use extends RuntimeUse<infer _Operations, infer Required, infer _Preferred, infer _Conditional>
    ? Required[number]
    : never;

type PreferredOf<Use> =
  Use extends RuntimeUse<infer _Operations, infer _Required, infer Preferred, infer _Conditional>
    ? Preferred[number]
    : never;

type ConditionalOf<Use> =
  Use extends RuntimeUse<infer _Operations, infer _Required, infer _Preferred, infer Conditional>
    ? Conditional[number]
    : never;

/** The non-disposable operation projection returned to a specialized handler. */
export type BoundDeviceRuntime<Use> = Readonly<{
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  facts: Readonly<
    Pick<
      RuntimeFacts<OperationsOf<Use>>['operations'],
      RequiredOf<Use> | PreferredOf<Use> | ConditionalOf<Use>
    >
  >;
  operations: Readonly<
    Pick<OperationsOf<Use>, RequiredOf<Use>> &
      Partial<Pick<OperationsOf<Use>, PreferredOf<Use> | ConditionalOf<Use>>>
  >;
}>;

/** The single trust choke point from a broad owner binding to a selected handler projection. */
export function narrowDeviceBinding<
  Operations extends object,
  const Required extends readonly RuntimeOperationKey<Operations>[],
  const Preferred extends readonly Exclude<RuntimeOperationKey<Operations>, Required[number]>[],
  const Conditional extends readonly Exclude<
    RuntimeOperationKey<Operations>,
    Required[number] | Preferred[number]
  >[],
>(
  binding: DeviceBinding<Operations>,
  use: RuntimeUse<Operations, Required, Preferred, Conditional>,
): BoundDeviceRuntime<RuntimeUse<Operations, Required, Preferred, Conditional>> {
  const selectedFacts: Record<string, RuntimeOperationFact> = {};
  const selectedOperations: Record<string, RuntimeOperation> = {};

  for (const key of use.required) {
    const fact = requireRuntimeFact(binding.facts.operations, key);
    selectedFacts[key] = fact;
    if (!fact.available) throw unsupportedRuntimeOperation(key, fact);
    selectedOperations[key] = requireRuntimeOperation(binding.operations, key);
  }

  for (const key of use.preferred) {
    const fact = requireRuntimeFact(binding.facts.operations, key);
    selectedFacts[key] = fact;
    if (fact.available) {
      selectedOperations[key] = requireRuntimeOperation(binding.operations, key);
    }
  }

  for (const key of use.conditional ?? []) {
    const fact = requireRuntimeFact(binding.facts.operations, key);
    selectedFacts[key] = fact;
    if (fact.available) {
      selectedOperations[key] = requireRuntimeOperation(binding.operations, key);
    }
  }

  return Object.freeze({
    device: binding.device,
    owner: binding.owner,
    facts: Object.freeze(selectedFacts),
    operations: Object.freeze(selectedOperations),
  }) as BoundDeviceRuntime<RuntimeUse<Operations, Required, Preferred, Conditional>>;
}

function requireRuntimeFact<Operations extends object>(
  facts: RuntimeFacts<Operations>['operations'],
  key: RuntimeOperationKey<Operations>,
): RuntimeOperationFact {
  const fact: unknown = facts[key];
  if (!hasRuntimeAvailability(fact)) {
    throw invalidRuntimeContract(`Runtime owner omitted the ${key} fact`);
  }
  const normalized = normalizeRuntimeFact(fact);
  if (normalized) return normalized;
  throw invalidRuntimeContract(`Runtime owner returned an invalid ${key} fact`);
}

type RuntimeFactInput = Readonly<{ available: unknown; reason?: unknown; hint?: unknown }>;

function hasRuntimeAvailability(value: unknown): value is RuntimeFactInput {
  return value !== null && typeof value === 'object' && 'available' in value;
}

function normalizeRuntimeFact(value: RuntimeFactInput): RuntimeOperationFact | undefined {
  if (value.available === true) return Object.freeze({ available: true });
  if (value.available !== false) return undefined;
  if (!isRuntimeOperationUnavailabilityReason(value.reason)) return undefined;
  if (value.hint !== undefined && typeof value.hint !== 'string') return undefined;
  return unavailableFact(value.reason, value.hint);
}

function requireRuntimeOperation<Operations extends object>(
  operations: DeviceBinding<Operations>['operations'],
  key: RuntimeOperationKey<Operations>,
): RuntimeOperation {
  const operation: unknown = operations[key];
  if (typeof operation !== 'function') {
    throw invalidRuntimeContract(`Runtime owner advertised ${key} without an implementation`);
  }
  return operation as RuntimeOperation;
}

function isRuntimeOperationUnavailabilityReason(
  value: unknown,
): value is RuntimeOperationUnavailability['reason'] {
  return (
    value === 'unsupported-platform-leaf' ||
    value === 'unsupported-device-kind' ||
    value === 'unsupported-device-backend' ||
    value === 'unsupported-device-scope' ||
    value === 'unsupported-provider-mode' ||
    value === 'owner-capability-missing' ||
    value === 'network-capture-post-session'
  );
}

function unsupportedRuntimeOperation(key: string, fact: RuntimeOperationUnavailability): AppError {
  return new AppError('UNSUPPORTED_OPERATION', `Runtime operation ${key} is unavailable`, {
    reason: fact.reason,
    hint: fact.hint,
  });
}
