import { isProductionSourceFile } from './tracked-sources.ts';
import type { LayeringViolation, ResolvedImportEdge } from './model.ts';

// The SessionState/SessionStore authority overlay (#2278, ADR 0022): which production files
// import the SessionState shape from src/daemon/types.ts and the SessionStore authority from
// src/daemon/session-store.ts, at symbol level so that a file importing only helper functions
// from session-store.ts is not an authority edge. R7 already owns the write side (field
// ownership); this overlay owns the read side. The ratchet applies to the handler-owned
// subset — the flat src/daemon/handlers/ surface the #2132 migration targeted — and is a
// membership ratchet against the merge-base: the set may only shrink, so a handler file
// gaining state-shape or store authority fails instead of silently regrowing the hotspot.

export const SESSION_AUTHORITY_OVERLAY_RULE = 'R75 session-authority-overlay';

const SESSION_STATE_SHAPE_TARGET = 'src/daemon/types.ts';
const SESSION_STORE_AUTHORITY_TARGET = 'src/daemon/session-store.ts';
const HANDLER_ROOT = 'src/daemon/handlers/';

export type SessionAuthorityOverlay = Readonly<{
  /** Production files importing the SessionState symbol from src/daemon/types.ts, sorted. */
  shapeFiles: readonly string[];
  /** Production files importing the SessionStore symbol from src/daemon/session-store.ts, sorted. */
  authorityFiles: readonly string[];
}>;

export function measureSessionAuthorityOverlay(
  edges: readonly ResolvedImportEdge[],
): SessionAuthorityOverlay {
  const shape = new Set<string>();
  const authority = new Set<string>();
  for (const edge of edges) {
    if (!isProductionSourceFile(edge.file)) continue;
    if (edge.target === SESSION_STATE_SHAPE_TARGET && edge.symbols.includes('SessionState')) {
      shape.add(edge.file);
    }
    if (edge.target === SESSION_STORE_AUTHORITY_TARGET && edge.symbols.includes('SessionStore')) {
      authority.add(edge.file);
    }
  }
  return { shapeFiles: [...shape].sort(), authorityFiles: [...authority].sort() };
}

/** The ratcheted subset: the flat handler surface, the one #2132's migration drove down. */
export function handlerOwnedOverlay(overlay: SessionAuthorityOverlay): SessionAuthorityOverlay {
  const inHandlers = (file: string) => file.startsWith(HANDLER_ROOT);
  return {
    shapeFiles: overlay.shapeFiles.filter(inHandlers),
    authorityFiles: overlay.authorityFiles.filter(inHandlers),
  };
}

/**
 * Catches: the handler-owned SessionState-shape / SessionStore-authority surface regrowing —
 *   a file under src/daemon/handlers/ importing either symbol that the merge-base does not
 *   already import it, which is exactly the deep-import the #2132 migration paid to delete.
 *   Both overlays are full-scope; the handler-owned subset is filtered here, at the single
 *   place the ratchet applies it, so the message can never name a file outside its scope.
 * Evidence: #2132's completion record (2026-09-02) moved handler-owned shape edges 55 -> 16
 *   and authority edges 50 -> 23 and left the residue to a fresh authority audit; #2278 ran
 *   that audit at origin/main 6e22e266d7 and measured 14/22 handler-owned (112/68
 *   repo-wide), classified in ADR 0022.
 * Cost: attributed to the R75 rule registration in check.ts; the measurement is folded into
 *   measureRatchets (ratchet-reference.ts), so the reference tree pays no extra pass.
 * Kill criterion: the handlers directory holds no SessionState/SessionStore importers
 *   (both sets empty), or a maintainer decision re-scopes where handler authority may live.
 */
export function checkSessionAuthorityOverlay(
  measured: SessionAuthorityOverlay,
  reference: SessionAuthorityOverlay,
): LayeringViolation[] {
  const scopedMeasured = handlerOwnedOverlay(measured);
  const scopedReference = handlerOwnedOverlay(reference);
  const violations: LayeringViolation[] = [];
  const known = (files: readonly string[]) => new Set(files);
  const referenceShape = known(scopedReference.shapeFiles);
  const referenceAuthority = known(scopedReference.authorityFiles);

  for (const file of scopedMeasured.shapeFiles) {
    if (referenceShape.has(file)) continue;
    violations.push({
      rule: SESSION_AUTHORITY_OVERLAY_RULE,
      file,
      line: 1,
      message:
        'new handler-owned SessionState shape edge: the merge-base holds no such import. ' +
        "Route the read through the owning module's facade or a named semantic query, or " +
        "accept the growth at ADR 0022's authority overlay explicitly.",
    });
  }
  for (const file of scopedMeasured.authorityFiles) {
    if (referenceAuthority.has(file)) continue;
    violations.push({
      rule: SESSION_AUTHORITY_OVERLAY_RULE,
      file,
      line: 1,
      message:
        'new handler-owned SessionStore authority edge: the merge-base holds no such import. ' +
        "Route the operation through the owning module's facade or a named store operation, " +
        "or accept the growth at ADR 0022's authority overlay explicitly.",
    });
  }
  return violations;
}
