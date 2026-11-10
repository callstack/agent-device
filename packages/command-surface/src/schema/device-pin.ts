import type { CliFlags } from '@agent-device/contracts/command';
import type { FlagKey } from '@agent-device/command-registry/flag-types';
import { AppError } from '@agent-device/kernel/errors';
import type { FlagProvenance, FlagValueSource } from './cli-config.ts';

/**
 * The opt-in device pin (#2161). `agent-device.json` already sets `platform`/`device`/`udid`/`serial`
 * DEFAULTS, and a default stays overridable by design. Setting `devicePin: true` beside them turns
 * those configured selectors into a pin: a selector-less command still inherits them, and a
 * selector that names a different value fails here with a typed reason instead of silently winning.
 * The pin guides selection only; it is not an ownership claim (#1320 device claims are).
 */
export const DEVICE_PIN_SELECTOR_KEYS = ['platform', 'device', 'udid', 'serial'] as const;

export type DevicePinSelectorKey = (typeof DEVICE_PIN_SELECTOR_KEYS)[number];

export type DevicePinSelector = Partial<Pick<CliFlags, DevicePinSelectorKey>>;

export const DEVICE_PIN_CONFLICT_REASON = 'device_pin_conflict';
export const DEVICE_PIN_WITHOUT_SELECTOR_REASON = 'device_pin_without_selector';

export type DevicePin = {
  /** The pinned selector values: every configured selector default while the pin is on. */
  selector: DevicePinSelector;
  /** Which layer set each pinned value. */
  sources: Partial<Record<DevicePinSelectorKey, FlagValueSource>>;
  /** Which layer turned the pin on (`devicePin: true`). */
  policySource: FlagValueSource;
};

/** Where a resolved selector value came from once defaults, the pin, and explicit input merged. */
export type SelectorValueOrigin = 'pin' | 'default' | 'flag';

export type SelectorOrigins = Partial<Record<DevicePinSelectorKey, SelectorValueOrigin>>;

/** The caller surface an explicit selector arrived on; it decides how the conflict names the key. */
export type DevicePinSurface = 'cli' | 'input';

const ENV_POLICY_SOURCE: FlagValueSource = {
  kind: 'env',
  label: 'environment variable AGENT_DEVICE_DEVICE_PIN',
};

/**
 * Reads the pin from resolved config/env defaults. Returns `undefined` while `devicePin` is off, so
 * every existing default keeps its overridable behavior. A pin with no selector to pin is a
 * misconfiguration and fails before any daemon is contacted.
 */
export function resolveDevicePin(
  defaults: Partial<CliFlags>,
  provenance: FlagProvenance,
): DevicePin | undefined {
  if (defaults.devicePin !== true) return undefined;
  const policySource = provenance.devicePin ?? ENV_POLICY_SOURCE;
  const selector: DevicePinSelector = {};
  const sources: DevicePin['sources'] = {};
  for (const key of DEVICE_PIN_SELECTOR_KEYS) {
    const value = defaults[key];
    if (value === undefined) continue;
    (selector as Record<string, unknown>)[key] = value;
    const source = provenance[key];
    if (source) sources[key] = source;
  }
  if (Object.keys(selector).length === 0) {
    throw new AppError(
      'INVALID_ARGS',
      `devicePin is set by ${policySource.label} but no platform, device, udid, or serial default is configured to pin. Add the selector beside it, or remove devicePin.`,
      { reason: DEVICE_PIN_WITHOUT_SELECTOR_REASON, pinSource: policySource.label },
    );
  }
  return { selector, sources, policySource };
}

/**
 * Fails when an explicit selector contradicts the pin. A selector that repeats a pinned value, or
 * names a key the pin leaves open (for example `--udid` under a pinned `device` name), refines the
 * pin and passes; the daemon's selection still has to satisfy both.
 */
export function assertSelectorHonorsDevicePin(
  pin: DevicePin,
  explicit: DevicePinSelector,
  surface: DevicePinSurface,
): void {
  const conflicts = DEVICE_PIN_SELECTOR_KEYS.flatMap((key) => {
    const requested = explicit[key];
    const pinned = pin.selector[key];
    if (requested === undefined || pinned === undefined) return [];
    if (selectorValuesMatch(requested, pinned)) return [];
    return [{ key, pinned, requested }];
  });
  if (conflicts.length === 0) return;
  const first = conflicts[0]!;
  const pinnedDescription = describeSelector(pin.selector);
  const message =
    `${describeKey(first.key, surface)} ${JSON.stringify(first.requested)} conflicts with the device pin ` +
    `from ${pin.policySource.label}, which pins ${pinnedDescription}. ` +
    `Edit or remove "devicePin" in that config to target another device.`;
  throw new AppError('INVALID_ARGS', message, {
    reason: DEVICE_PIN_CONFLICT_REASON,
    pin: { ...pin.selector },
    pinSource: pin.policySource.label,
    conflicts,
    hint: `This project pins ${pinnedDescription} (${pin.policySource.label}). Drop the conflicting selector to use the pinned device, or change the pin in that config.`,
  });
}

/**
 * Records where each resolved selector value came from: `flag` for an explicit value, `pin` for a
 * value the pin supplied, `default` for an overridable configured default.
 */
export function resolveSelectorOrigins(
  flags: Partial<CliFlags>,
  explicitKeys: ReadonlySet<FlagKey>,
  pin: DevicePin | undefined,
): SelectorOrigins {
  const origins: SelectorOrigins = {};
  for (const key of DEVICE_PIN_SELECTOR_KEYS) {
    if (flags[key] === undefined) continue;
    if (explicitKeys.has(key)) origins[key] = 'flag';
    else if (pin?.selector[key] !== undefined) origins[key] = 'pin';
    else origins[key] = 'default';
  }
  return origins;
}

/** Picks the selector keys an explicit source set, ignoring everything else it carries. */
export function pickExplicitSelector(
  values: Partial<CliFlags>,
  explicitKeys: ReadonlySet<FlagKey>,
): DevicePinSelector {
  const explicit: DevicePinSelector = {};
  for (const key of DEVICE_PIN_SELECTOR_KEYS) {
    if (!explicitKeys.has(key) || values[key] === undefined) continue;
    (explicit as Record<string, unknown>)[key] = values[key];
  }
  return explicit;
}

function selectorValuesMatch(requested: string, pinned: string): boolean {
  return requested.trim() === pinned.trim();
}

function describeKey(key: DevicePinSelectorKey, surface: DevicePinSurface): string {
  return surface === 'cli' ? `--${key}` : key;
}

function describeSelector(selector: DevicePinSelector): string {
  return DEVICE_PIN_SELECTOR_KEYS.filter((key) => selector[key] !== undefined)
    .map((key) => `${key} ${JSON.stringify(selector[key])}`)
    .join(', ');
}
