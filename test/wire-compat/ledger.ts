/**
 * The daemon RPC wire ledger: what the wire surface hashed to, at which
 * protocol version, plus the acknowledgments that let a compatible change
 * through without a bump (#1432).
 *
 * JSON rather than TypeScript on purpose. `scripts/check-daemon-wire-compat.ts`
 * has to read this same file as it stood at the LAST RELEASED TAG
 * (`git show <tag>:test/wire-compat/ledger.json`); JSON parses identically at
 * any commit, while a `.ts` ledger would have to be evaluated in whatever
 * module shape that release happened to use.
 *
 * There is deliberately no regenerate script. A stale entry is fixed by
 * pasting the one digest the failure message prints, so every ledger line in a
 * diff is a wire declaration someone decided to change — the same reason
 * `fallow-baselines` are not bulk-refreshed (AGENTS.md).
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * An accepted wire change that does NOT need a protocol bump — ADR 0006's
 * "additive changes" list (a new optional request field an older daemon can
 * ignore, a new optional response field an older client can ignore).
 *
 * Keyed by the digest the declaration moved TO, so an ack cannot be recycled:
 * the next change to the same declaration produces a different digest and
 * needs its own rationale.
 */
export type WireCompatibleChange = {
  /** `<file>#<name>`, matching a manifest declaration. */
  declaration: string;
  /** The post-change digest this ack covers. */
  digest: string;
  /** Why a peer on the previous protocol version still parses correctly. */
  rationale: string;
};

export type WireLedger = {
  /**
   * Literal copy of `DAEMON_RPC_PROTOCOL_VERSION`. Literal, not imported: an
   * imported value would make bumping the constant update the ledger by
   * itself, and the released-tag check reads this number out of an old commit
   * where the import would not resolve.
   */
  protocolVersion: number;
  /** `<file>#<name>` → digest. */
  declarations: Record<string, string>;
  compatibleChanges: WireCompatibleChange[];
};

export const WIRE_LEDGER_PATH = 'test/wire-compat/ledger.json';

export function parseWireLedger(raw: string, origin: string): WireLedger {
  const parsed = JSON.parse(raw) as Partial<WireLedger>;
  if (typeof parsed.protocolVersion !== 'number') {
    throw new Error(`${origin} is missing a numeric "protocolVersion".`);
  }
  if (!parsed.declarations || typeof parsed.declarations !== 'object') {
    throw new Error(`${origin} is missing a "declarations" object.`);
  }
  if (!Array.isArray(parsed.compatibleChanges)) {
    throw new Error(`${origin} is missing a "compatibleChanges" array.`);
  }
  return {
    protocolVersion: parsed.protocolVersion,
    declarations: parsed.declarations,
    compatibleChanges: parsed.compatibleChanges,
  };
}

export function readWireLedger(repoRoot: string): WireLedger {
  const file = path.join(repoRoot, WIRE_LEDGER_PATH);
  return parseWireLedger(fs.readFileSync(file, 'utf8'), WIRE_LEDGER_PATH);
}

/** Current digests for every declaration the manifest lists. */
export function digestWireSurface(
  repoRoot: string,
  declarations: readonly { file: string; name: string }[],
  digest: (file: string, source: string, name: string) => string,
): Map<string, string> {
  const sources = new Map<string, string>();
  const digests = new Map<string, string>();
  for (const ref of declarations) {
    let source = sources.get(ref.file);
    if (source === undefined) {
      source = fs.readFileSync(path.join(repoRoot, ref.file), 'utf8');
      sources.set(ref.file, source);
    }
    digests.set(`${ref.file}#${ref.name}`, digest(ref.file, source, ref.name));
  }
  return digests;
}
