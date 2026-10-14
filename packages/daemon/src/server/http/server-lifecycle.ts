export { readVersion } from '@agent-device/host-kit/version';
export {
  resolveDaemonCodeOrigin,
  resolveDaemonCodeSignature,
} from '@agent-device/host-kit/code-signature';

export function parseIntegerEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) return undefined;
  return value;
}
