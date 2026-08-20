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

export function runtimeOwnerKey(owner: RuntimeOwnerRef): string {
  return owner.kind === 'local-family'
    ? `local:${owner.family}`
    : `provider:${JSON.stringify([owner.provider, owner.instance])}`;
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
    | 'unsupported-provider-mode'
    | 'owner-capability-missing';
  hint?: string;
}>;

export type RuntimeOperationFact = Readonly<{ available: true }> | RuntimeOperationUnavailability;

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
  /** Complete close compatibility capability; unlike bind, this never admits a runtime facet. */
  getCloseShutdown?: () => Promise<
    import('./device-shutdown-runtime.ts').DeviceShutdownCloseCapability
  >;
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
  return Object.freeze({
    available: false,
    reason: value.reason,
    ...(value.hint === undefined ? {} : { hint: value.hint }),
  });
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
    value === 'unsupported-provider-mode' ||
    value === 'owner-capability-missing'
  );
}

function unsupportedRuntimeOperation(key: string, fact: RuntimeOperationUnavailability): AppError {
  return new AppError('UNSUPPORTED_OPERATION', `Runtime operation ${key} is unavailable`, {
    reason: fact.reason,
    hint: fact.hint,
  });
}
