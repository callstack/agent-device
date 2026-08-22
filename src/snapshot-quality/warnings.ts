import type { SnapshotNode, SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';

/** Canonical warning lines for a verdict; the single place degradation is worded. */
export function renderSnapshotQualityWarnings(
  verdict: SnapshotQualityVerdict,
  nodes: Pick<SnapshotNode, 'index' | 'ref' | 'type' | 'identifier' | 'label'>[],
): string[] {
  return [
    ...stateWarning(verdict),
    ...customActionCoverageWarning(verdict),
    ...depthWarning(verdict),
    ...collapsedLeafWarnings(verdict, nodes),
  ];
}

/**
 * Disclosed at response level, once, and only when the pass was incomplete: a
 * merged element the bounded pass never reached renders exactly like one with
 * no custom actions, so staying silent would teach the reader that the rest of
 * the list has no affordances — the mis-inference `--actions` exists to stop.
 *
 * The remedy is scrolling, not `--scope`: the runner reads on-screen elements
 * first, and scope is applied after the read pass, so it cannot redirect the
 * budget.
 */
function customActionCoverageWarning(verdict: SnapshotQualityVerdict): string[] {
  const coverage = verdict.customActions;
  if (!coverage) return [];
  const lines: string[] = [];
  if (coverage.blocked) {
    // Not a budget stop, so it must not borrow the budget stop's remedy:
    // scrolling cannot clear a hung read, and telling the reader to try would
    // send them in circles.
    lines.push(
      'Custom actions were not read: an earlier accessibility read is still hung, so this capture skipped the read pass instead of queueing behind it. No element’s actions list is authoritative here. Reads resume once that call returns.',
    );
  } else if (coverage.read < coverage.candidates) {
    lines.push(
      `Custom actions were read for ${coverage.read} of ${coverage.candidates} merged elements, on-screen ones first; the remaining ${coverage.candidates - coverage.read} were not read, so an absent actions list on those is not evidence that they have none. Scroll them into view and re-run to read them.`,
    );
  }
  if (coverage.truncated > 0) {
    // A clipped list looks complete, which is the same failure mode as an
    // unread element, so it gets its own line rather than a silent cap.
    lines.push(
      `${coverage.truncated} element(s) published more custom actions than are shown; those lists are clipped to the first 8 names, and long names are shortened.`,
    );
  }
  return lines;
}

/**
 * The full recovered-state warning line. Shared with the daemon's one-shot deferred
 * latch (`src/daemon/snapshot-quality-latch.ts`), which re-renders it exactly once when
 * the penalty was armed by an internal capture that never reached the user.
 */
export function recoveredSnapshotQualityWarning(
  backend: SnapshotQualityVerdict['backend'],
): string {
  return `Detected an overly complex or slow accessibility tree. Fell back to the ${backend} snapshot backend. It is OK to continue; use --json to inspect snapshotQuality.reason if you need recovery details.`;
}

function stateWarning(verdict: SnapshotQualityVerdict): string[] {
  if (verdict.state === 'recovered') {
    // Penalty-deferred captures repeat on every capture of a hostile screen, so the full
    // warning is suppressed here. When the capture that ARMED the penalty was internal
    // (selector resolution, settle observation loops, system-modal probes) and never rendered it,
    // the daemon's session latch re-renders the warning once at the response seam.
    if (verdict.reasonCode === 'deferred' || verdict.reasonCode === 'requested-backend') return [];
    if (verdict.reasonCode === 'presentation-failed') {
      return [
        `Agent Device could not safely present the captured accessibility tree and fell back to the ${verdict.backend} snapshot backend. This is an Agent Device runner bug, not an app accessibility-tree issue. Use screenshot as visual truth and report snapshotQuality.reason with the screenshot.`,
      ];
    }
    return [recoveredSnapshotQualityWarning(verdict.backend)];
  }
  if (verdict.state === 'sparse') {
    return [
      'No snapshot backend could read this screen' +
        (verdict.reason ? ` (${verdict.reason})` : '') +
        '. Its refs and selectors are invalid. Use screenshot as visual truth and coordinate taps; retry snapshot after navigating.',
      ...appAccessibilityDefectWarning(verdict),
    ];
  }
  return [];
}

/**
 * Only `sparse-tree` is evidence about the app: every backend reached the screen and it
 * published no semantic content. Other sparse reasons describe capture limits and must
 * not be presented as an application accessibility defect.
 */
function appAccessibilityDefectWarning(verdict: SnapshotQualityVerdict): string[] {
  if (verdict.reasonCode !== 'sparse-tree') return [];
  return [
    'This screen publishes no accessibility content at all; assistive technologies see the same empty tree, so it is worth flagging as an app accessibility bug rather than only an automation limitation.',
  ];
}

function depthWarning(verdict: SnapshotQualityVerdict): string[] {
  if (verdict.effectiveDepth === undefined) return [];
  return [
    `Some deeper accessibility nodes were omitted; this tree is capped at depth ${verdict.effectiveDepth}. Re-run with --depth ${verdict.effectiveDepth} --scope <container> only if you need deeper content.`,
  ];
}

function collapsedLeafWarnings(
  verdict: SnapshotQualityVerdict,
  nodes: Pick<SnapshotNode, 'index' | 'ref' | 'type' | 'identifier' | 'label'>[],
): string[] {
  const warnings: string[] = [];
  for (const index of verdict.collapsedLeafIndexes ?? []) {
    const node = nodes.find((entry) => entry.index === index);
    if (!node) continue;
    const name = node.identifier ? ` (${node.identifier})` : '';
    warnings.push(
      `@${node.ref} [${node.type ?? 'element'}]${name} merges many labels into a single accessibility element. The app likely marks a container as accessible, which hides every descendant from assistive tech and automation — the children cannot be addressed individually. Fix the app's accessibility (mark the rows, not the container); until then use screenshot as visual truth and coordinate taps.`,
    );
  }
  return warnings;
}
