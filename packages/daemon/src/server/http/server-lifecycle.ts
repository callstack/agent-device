export { readVersion } from '@agent-device/host-kit/version';
export {
  resolveDaemonCodeOrigin,
  resolveDaemonCodeSignature,
} from '@agent-device/host-kit/code-signature';

/** Reads a decimal integer env value; unset, empty, and any other spelling read as unset. */
export function parseIntegerEnv(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || !/^-?\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
}
