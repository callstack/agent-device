import crypto from 'node:crypto';
import { AppError } from './errors.ts';
import type { AppleOS, DeviceInfo, DeviceKind, DeviceTarget, Platform } from './device.ts';

export type DeviceShape = Readonly<{
  family: Platform;
  appleOs?: AppleOS;
  kind: DeviceKind;
  target?: DeviceTarget;
  iosPhysicalDeviceBackend?: DeviceInfo['iosPhysicalDeviceBackend'];
}>;

export type DeviceIdentity = DeviceShape & Readonly<{ id: string }>;

type DeviceIdentitySource = Pick<
  DeviceInfo,
  'platform' | 'appleOs' | 'id' | 'kind' | 'target' | 'iosPhysicalDeviceBackend'
>;

/** Canonical ownership-qualified device shape, excluding presentation and observation fields. */
export function deviceShape(device: DeviceIdentitySource): DeviceShape {
  return Object.freeze({
    family: device.platform,
    ...(device.appleOs === undefined ? {} : { appleOs: device.appleOs }),
    kind: device.kind,
    ...(device.target === undefined ? {} : { target: device.target }),
    ...(device.iosPhysicalDeviceBackend === undefined
      ? {}
      : { iosPhysicalDeviceBackend: device.iosPhysicalDeviceBackend }),
  });
}

/** Canonical identity shared by runtime binding, facts, and durable-resource ownership. */
export function deviceIdentity(device: DeviceIdentitySource): DeviceIdentity {
  return Object.freeze({ id: device.id, ...deviceShape(device) });
}

export function deviceIdentityKey(identity: DeviceIdentity): string {
  return JSON.stringify([identity.id, ...deviceShapeParts(identity)]);
}

export function sameDeviceIdentity(left: DeviceIdentity, right: DeviceIdentity): boolean {
  return deviceIdentityKey(left) === deviceIdentityKey(right);
}

export function sameDeviceShape(left: DeviceShape, right: DeviceShape): boolean {
  return JSON.stringify(deviceShapeParts(left)) === JSON.stringify(deviceShapeParts(right));
}

function deviceShapeParts(shape: DeviceShape): readonly unknown[] {
  return [
    shape.family,
    shape.appleOs ?? null,
    shape.kind,
    shape.target ?? null,
    shape.iosPhysicalDeviceBackend ?? null,
  ];
}

// HOST-SCOPED DEVICE ID ARITHMETIC. A host device (macOS, a web workspace) can hold app devices
// and web session devices of its own (ADR 0035). Their ids are derived from the host's id plus a
// scoped infix, so this is the identity grammar those derived devices carry, beside the canonical
// shape above.

const HOST_APP_DEVICE_ID_INFIX = ':app:';
const WEB_SESSION_DEVICE_ID_INFIX = ':session:';
export const HOST_SCOPED_DEVICE_ID_INFIXES = [
  HOST_APP_DEVICE_ID_INFIX,
  WEB_SESSION_DEVICE_ID_INFIX,
];

const MACOS_BUNDLE_ID_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;

/** A macOS bundle id in reverse-DNS form such as com.apple.TextEdit; any segment may be mixed-case. */
export function isMacOsBundleId(value: string): boolean {
  return MACOS_BUNDLE_ID_PATTERN.test(value);
}

/** Bundle ids match without regard to case, as LaunchServices matches them. */
export function hostAppDeviceId(hostDeviceId: string, bundleId: string): string {
  return `${hostDeviceIdPrefix(hostDeviceId)}${bundleId.toLowerCase()}`;
}

/** The host of an app or web session device id, or the id itself for any other device. */
export function hostDeviceIdOf(deviceId: string): string {
  const infixes = HOST_SCOPED_DEVICE_ID_INFIXES.map((infix) => deviceId.indexOf(infix)).filter(
    (index) => index >= 0,
  );
  return infixes.length === 0 ? deviceId : deviceId.slice(0, Math.min(...infixes));
}

/** A device id as devices carry it: the bundle part of an app device id is lowercase. */
export function canonicalDeviceId(deviceId: string): string {
  const hostDeviceId = hostDeviceIdOf(deviceId);
  const prefix = hostDeviceIdPrefix(hostDeviceId);
  return deviceId.startsWith(prefix)
    ? hostAppDeviceId(hostDeviceId, deviceId.slice(prefix.length))
    : deviceId;
}

/** The id prefix every app device of `hostDeviceId` shares. */
export function hostDeviceIdPrefix(hostDeviceId: string): string {
  return `${hostDeviceId}${HOST_APP_DEVICE_ID_INFIX}`;
}

/** One app of `host`, held as a device of its own. */
export function hostAppDevice(host: DeviceInfo, bundleId: string): DeviceInfo {
  return {
    ...host,
    id: hostAppDeviceId(host.id, bundleId),
    hostApp: { hostDeviceId: host.id, bundleId },
  };
}

const WEB_BACKEND_KEY_PREFIX = 'p_';
const WEB_TENANT_KEY_HASH_LENGTH = 12;

const WEB_SESSION_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * The wire reasons this identity grammar publishes, declared once and read by name at the throw
 * site (ADR 0037 documents each value). A declared table keeps the vocabulary in one place
 * instead of inlined at every caller.
 */
const WEB_SESSION_IDENTITY_REASONS = {
  invalidSessionName: 'web_session_name_invalid',
} as const;

// agent-browser binds its control socket at `<tmpdir>/adw/<12 hex>/<key>.sock` and refuses a path
// over 103 bytes. The macOS per-user tmpdir is 48 bytes, the longest of the supported hosts.
const SOCKET_PATH_MAX_BYTES = 103;
const SOCKET_DIR_BYTES = 48 + '/adw/'.length + 12;
const SOCKET_FILE_OVERHEAD_BYTES = '/'.length + '.sock'.length;

/** The most characters a web backend session key can hold. */
const WEB_BACKEND_KEY_MAX_LENGTH =
  SOCKET_PATH_MAX_BYTES - SOCKET_DIR_BYTES - SOCKET_FILE_OVERHEAD_BYTES;

/** A named session with an optional tenant, or an implicit workspace session without a name. */
export type WebSessionIdentity =
  | Readonly<{ name: string; namespace?: { kind: 'tenant'; id: string } }>
  | Readonly<{ kind: 'workspace'; id: string }>;

function webBackendKeyPrefix(tenantId: string | undefined): string {
  if (tenantId === undefined) return WEB_BACKEND_KEY_PREFIX;
  const hash = crypto.createHash('sha256').update(tenantId).digest('hex');
  return `t_${hash.slice(0, WEB_TENANT_KEY_HASH_LENGTH)}_`;
}

/** Validate the backend's name and socket limits. Its charset excludes `:` from device-id infixes. */
function requireWebSessionName(sessionName: string, keyPrefixLength: number): string {
  const name = sessionName.toLowerCase();
  const maxLength = WEB_BACKEND_KEY_MAX_LENGTH - keyPrefixLength;
  if (!WEB_SESSION_NAME_PATTERN.test(sessionName) || name.length > maxLength) {
    throw new AppError(
      'INVALID_ARGS',
      `A web session name must be 1 to ${maxLength} characters of letters, digits, "_" and "-".`,
      {
        reason: WEB_SESSION_IDENTITY_REASONS.invalidSessionName,
        sessionName,
        maxLength,
        hint: 'Pass --session with a name such as "checkout-1".',
      },
    );
  }
  return name;
}

/**
 * The key agent-browser isolates a browser on, derived once from the session: `p_<name>`, or
 * `t_<hash12 of the tenant>_<name>` under tenant isolation, or `w_<scope id>` for an implicit
 * workspace session.
 */
export function webSessionBackendKey(session: WebSessionIdentity): string {
  if ('kind' in session) return `w_${session.id}`;
  const prefix = webBackendKeyPrefix(session.namespace?.id);
  return `${prefix}${requireWebSessionName(session.name, prefix.length)}`;
}

/**
 * One web session of `host`, held as a device of its own. Its id carries the backend key, so two
 * names that drive one browser are one device and every reader takes the same key from it.
 */
export function webSessionDevice(host: DeviceInfo, session: WebSessionIdentity): DeviceInfo {
  const id = `${host.id}${WEB_SESSION_DEVICE_ID_INFIX}${webSessionBackendKey(session)}`;
  return { ...host, id };
}

/** The backend key a web session device id carries, or `undefined` for any other device id. */
export function webBackendKeyOf(deviceId: string): string | undefined {
  const rest = deviceId.slice(hostDeviceIdOf(deviceId).length);
  return rest.startsWith(WEB_SESSION_DEVICE_ID_INFIX)
    ? rest.slice(WEB_SESSION_DEVICE_ID_INFIX.length)
    : undefined;
}
