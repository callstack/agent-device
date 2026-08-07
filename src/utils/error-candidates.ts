/**
 * The candidate lists an error's `details` may carry, and the text rendering
 * shared by the CLI (`printHumanError`, src/utils/output.ts) and MCP
 * (`formatToolErrorText`, src/mcp/tool-error.ts) so an agent sees them on every
 * surface, never only in `--json`/`--debug` (#1597).
 *
 * Two different domains disclose candidates, so each owns its own details key:
 * element matches from find and interaction ambiguity errors (`candidates`,
 * pre-rendered snapshot lines) and booted simulators from the Apple device
 * resolvers (`devices`).
 * They shared one key until this module existed, which left the renderer
 * disambiguating two incompatible shapes by heuristic; a third producer now
 * declares which domain it is instead of colliding.
 */

/**
 * Element `AMBIGUOUS_MATCH` details from find or interaction resolution.
 * `candidates` are pre-rendered snapshot lines capped by the producer;
 * `matches` is the true total, so a capped list can render its `+N more`
 * marker. Mutating interaction errors also carry the partial frame generation.
 */
export type ElementMatchCandidateDetails = {
  candidates: string[];
  matches: number;
  refsGeneration?: number;
};

/**
 * `AMBIGUOUS_MATCH` / `APP_NOT_INSTALLED` from `findBootedAppleSimulatorWithApp`
 * (src/core/dispatch-resolve.ts). The udid leads because the recovery hint is
 * "pass --udid".
 */
export type DeviceCandidateDetails = {
  devices: Array<{ id: string; name: string }>;
};

export function formatErrorCandidateLines(details: Record<string, unknown> | undefined): string[] {
  return [...formatElementMatchLines(details), ...formatDeviceLines(details)];
}

function formatElementMatchLines(details: Record<string, unknown> | undefined): string[] {
  const candidates = readStringArray(details?.candidates);
  if (candidates.length === 0) return [];
  const total = typeof details?.matches === 'number' ? details.matches : candidates.length;
  const generation =
    typeof details?.refsGeneration === 'number' ? details.refsGeneration : undefined;
  const remaining = total - candidates.length;
  return [
    'Candidates:',
    ...candidates.map((candidate) => `  ${pinCandidateLine(candidate, generation)}`),
    ...(remaining > 0 ? [`  +${remaining} more`] : []),
  ];
}

export function readElementMatchCandidateRefs(
  details: Record<string, unknown> | undefined,
): string[] {
  return readStringArray(details?.candidates).flatMap((candidate) => {
    const match = /^@(e\d+)(?:~s\d+)?(?:\s|$)/.exec(candidate);
    return match?.[1] ? [match[1]] : [];
  });
}

function pinCandidateLine(candidate: string, generation: number | undefined): string {
  if (generation === undefined) return candidate;
  return candidate.replace(/^@(e\d+)(?=\s|$)/, `@$1~s${generation}`);
}

function formatDeviceLines(details: Record<string, unknown> | undefined): string[] {
  const devices = readDeviceList(details?.devices);
  if (devices.length === 0) return [];
  return ['Devices:', ...devices.map((device) => `  ${device.id}  ${device.name}`)];
}

// `details` crosses the daemon RPC wire as JSON, so both readers narrow rather
// than trust. Skew-safe by construction: a payload from a daemon that predates
// the `devices` key contributes nothing to either list.
function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function readDeviceList(value: unknown): DeviceCandidateDetails['devices'] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is DeviceCandidateDetails['devices'][number] =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { id?: unknown }).id === 'string' &&
      typeof (entry as { name?: unknown }).name === 'string',
  );
}
