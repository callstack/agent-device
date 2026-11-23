import type {
  NativeAuditFinding,
  AuditChecks,
  AuditContext,
  AuditFinding,
  AuditFindingKind,
  AuditResult,
  AuditScreenReaderOrder,
  AuditSizeUnit,
  SnapshotScreenReaderOrderEvidence,
} from '@agent-device/contracts/capture';
import { readSnapshotClickabilityEvidence } from '@agent-device/contracts/snapshot-private-evidence';
import { isNativeIosSnapshotBarNode, normalizeType } from '@agent-device/contracts/snapshot';
import type { SnapshotState } from '@agent-device/contracts/snapshot-model';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import { formatRole, type Rect, type SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  buildChildrenByParent,
  collectDescendants,
  type ChildrenByParent,
} from './snapshot-tree.ts';

const IOS_TARGET_PT = 44;
const ANDROID_TARGET_DP = 48;
/** Rects round-trip through float layout, so a 44pt control can read 43.67. */
const SIZE_TOLERANCE = 0.5;
const GENERIC_RESOURCE_ID = /^[\w.]+:id\/[\w.-]+$/i;

// Longest suffix first: `radiobutton` also ends with `button`. A suffix match keeps
// containers such as `RadioGroup` and `TabLayout` out of the control set.
const CONTROL_ROLES: ReadonlyArray<readonly [suffix: string, role: string]> = [
  ['radiobutton', 'radio'],
  ['radio', 'radio'],
  ['segmentedcontrol', 'segmented-control'],
  ['button', 'button'],
  ['link', 'link'],
  ['switch', 'switch'],
  ['checkbox', 'checkbox'],
  ['slider', 'slider'],
  ['seekbar', 'slider'],
  ['menuitem', 'menu-item'],
  ['searchfield', 'search-field'],
  ['searchbox', 'search-field'],
  ['textfield', 'text-field'],
  ['edittext', 'text-field'],
  ['textbox', 'text-field'],
  ['combobox', 'combobox'],
];

const EDITABLE_ROLES = new Set(['text-field', 'search-field', 'combobox']);

/** Role a role-less Android touchable reports as: the tap fact is all the capture published. */
const ANDROID_TOUCHABLE_ROLE = 'clickable';

type SizeRule =
  | { kind: 'checked'; unit: AuditSizeUnit; recommended: number; scale: number }
  | { kind: 'unchecked'; limitation: string };

/** The captured-screen facts every audit pass reads. */
type AuditFacts = {
  platform: AuditContext['platform'];
  producer: AuditContext['producer'];
  byIndex: ReadonlyMap<number, SnapshotNode>;
  children: ChildrenByParent;
};

type AuditScan = AuditFacts & {
  /** Each control the audit judges, keyed by node index, resolved once per audit. */
  evaluated: ReadonlyMap<number, EvaluatedControl>;
  /** Name groups that two or more logical controls share on this screen. */
  sharedNames: ReadonlyMap<string, number>;
};

type EvaluatedControl = { role: string; ownership: ControlOwnership; name: string | undefined };

/** A group joins role and lowercased name with NUL, because a name is any text. */

function nameGroupKey(role: string, name: string): string {
  return `${role}\0${name.toLowerCase()}`;
}

/**
 * Advisory accessibility findings for one captured screen. Runs on the semantic nodes as
 * captured, before display label dedup, and reads only facts the capture already published.
 */
export function auditSnapshot(nodes: readonly SnapshotNode[], context: AuditContext): AuditResult {
  const facts: AuditFacts = {
    platform: context.platform,
    producer: context.producer,
    byIndex: new Map(nodes.map((node) => [node.index, node])),
    children: buildChildrenByParent(nodes),
  };
  const evaluated = new Map(
    nodes.flatMap((node) => {
      const control = evaluateControl(node, facts);
      return control === undefined ? [] : [[node.index, control] as const];
    }),
  );
  const scan: AuditScan = {
    ...facts,
    evaluated,
    sharedNames: countSharedNames(nodes, evaluated, facts),
  };
  const rule = resolveSizeRule(context);
  const findings = nodes.flatMap((node) => auditNode(node, scan, rule));
  return {
    findings,
    guidance: auditGuidance(findings, context),
    checks: { snapshot: snapshotCompleteness(context) },
    limitations: collectLimitations(context, rule),
  };
}

/** A control the app owns and the user can see, or none when the audit does not judge the node. */
function evaluateControl(node: SnapshotNode, facts: AuditFacts): EvaluatedControl | undefined {
  const role = auditRole(node, facts);
  if (role === undefined || node.ref === undefined) return undefined;
  const ownership = controlOwnership(node, facts);
  if (!isActionable(node, ownership)) return undefined;
  return { role, ownership, name: accessibleName(node, role, facts) };
}

/**
 * Counts logical controls per name group: one control exposed twice counts once. A role-less
 * Android touchable never joins a group: its name comes from its first named descendant, while
 * TalkBack announces it by joining every descendant's text, so two containers with an equal first
 * child can announce different names and a shared first child proves nothing.
 */
function countSharedNames(
  nodes: readonly SnapshotNode[],
  evaluated: ReadonlyMap<number, EvaluatedControl>,
  facts: AuditFacts,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const control = evaluated.get(node.index);
    if (control?.name === undefined) continue;
    // TalkBack reads a role-less touchable named by its descendants as their joined text, which the
    // audit does not rebuild. Only a touchable with its own name joins a group.
    if (control.role === ANDROID_TOUCHABLE_ROLE && ownName(node, false) === undefined) continue;
    if (isDuplicateExposure(node, control.role, facts, evaluated)) continue;
    const group = nameGroupKey(control.role, control.name);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return new Map([...counts].filter(([, count]) => count > 1));
}

/**
 * Audits one captured screen held in a snapshot state. Regular Android snapshots leave the raw
 * tap facts off their nodes, so the helper's retained clickability evidence is folded back onto
 * the nodes first; platforms that publish no tap fact audit the nodes as captured.
 */
export async function auditSnapshotState(
  snapshot: SnapshotState,
  context: AuditContext,
): Promise<AuditResult> {
  const { readSnapshotScreenReaderOrderEvidence } = await import('@agent-device/contracts/capture');
  const audit = auditSnapshot(withRetainedTapFacts(snapshot), context);
  const evidence = await readSnapshotScreenReaderOrderEvidence(snapshot);
  if (!evidence) return audit;
  const screenReaderOrder = estimatedScreenReaderOrder(snapshot, evidence);
  if (!screenReaderOrder) return audit;
  return {
    ...audit,
    screenReaderOrder,
    limitations: [...audit.limitations, SCREEN_READER_ORDER_LIMITATION],
  };
}

const SCREEN_READER_ORDER_LIMITATION =
  "The screen-reader order is estimated from TalkBack 16.2's rules, not observed. It leaves out auto-scroll, scrolling past the screen, the order across windows, and web content.";

/** The producer's TalkBack order estimate as refs, without windows that hold no stop. */
function estimatedScreenReaderOrder(
  snapshot: SnapshotState,
  evidence: SnapshotScreenReaderOrderEvidence,
): AuditScreenReaderOrder | undefined {
  const refByIndex = new Map(
    snapshot.nodes.flatMap((node) => (node.ref ? [[node.index, `@${node.ref}`] as const] : [])),
  );
  const windows = evidence.windows.flatMap(({ nodeIndexes, omittedStops }) => {
    const refs = nodeIndexes.flatMap((index) => refByIndex.get(index) ?? []);
    const omitted = omittedStops + nodeIndexes.length - refs.length;
    if (refs.length === 0 && omitted === 0) return [];
    return [{ refs, ...(omitted > 0 ? { omittedStops: omitted } : {}) }];
  });
  return windows.length > 0 ? { estimatedFrom: 'talkback-16.2', windows } : undefined;
}

function withRetainedTapFacts(snapshot: SnapshotState): readonly SnapshotNode[] {
  const evidence = readSnapshotClickabilityEvidence(snapshot);
  if (!evidence || evidence.kind !== 'exact' || evidence.provider !== 'android-helper') {
    return snapshot.nodes;
  }
  return snapshot.nodes.map((node) => {
    const clickable = evidence.clickableByNodeIndex.get(node.index);
    const longClickable = evidence.longClickableByNodeIndex.get(node.index);
    if (clickable === undefined && longClickable === undefined) return node;
    return {
      ...node,
      ...(clickable === undefined ? {} : { clickable }),
      ...(longClickable === undefined ? {} : { longClickable }),
    };
  });
}

function snapshotCompleteness(context: AuditContext): AuditChecks['snapshot'] {
  if (context.truncated === undefined) return 'unknown';
  return context.truncated ? 'partial' : 'complete';
}

function auditNode(node: SnapshotNode, scan: AuditScan, rule: SizeRule): AuditFinding[] {
  if (node.ref === undefined) return [];
  const role = auditRole(node, scan);
  const control =
    role === undefined
      ? []
      : collapseIntoParent(node, role, controlFindings(node, role, scan, rule), scan, rule);
  const covered = coveredFinding(node, scan);
  return covered ? [...control, covered] : control;
}

/** Findings for a control the app owns and the user can see; none for any other node. */
function controlFindings(
  node: SnapshotNode,
  role: string,
  scan: AuditScan,
  rule: SizeRule,
): AuditFinding[] {
  const control = scan.evaluated.get(node.index);
  if (control === undefined) return [];
  const small =
    control.ownership === 'platform-sized' || isInlineLink(node, role, scan)
      ? undefined
      : smallTargetFinding(node, role, rule);
  const name = control.name;
  const unnamed = name === undefined ? missingNameFinding(node, role) : undefined;
  const shared = ambiguousNameFinding(node, role, name, scan);
  return [small, unnamed, shared].filter((finding) => finding !== undefined);
}

/**
 * One control exposed twice: the only child of a control of the same role. The child's finding
 * drops only when that parent reports the same kind, so a collapse never leaves a screen silent.
 * A role-less clickable container whose only actionable descendant is a control counts as that
 * control's wrapper too, so the pair reports once, on the container.
 */
function collapseIntoParent(
  node: SnapshotNode,
  role: string,
  findings: AuditFinding[],
  scan: AuditScan,
  rule: SizeRule,
): AuditFinding[] {
  const parent = parentOf(node, scan);
  if (parent && isDuplicateExposure(node, role, scan, scan.evaluated)) {
    return dropFindingsInto(parent, role, findings, scan, rule);
  }
  const container = touchableContainerAncestor(node, scan);
  if (!container || !isSoleActionableDescendant(container, node, scan)) return findings;
  return dropFindingsInto(container, ANDROID_TOUCHABLE_ROLE, findings, scan, rule);
}

/**
 * The only child of an evaluated control of the same role: the same control, exposed twice. A
 * parent the audit does not judge (disabled, unhittable, system-owned, ref-less) cannot speak for
 * the child, so the child stays a control of its own.
 */
function isDuplicateExposure(
  node: SnapshotNode,
  role: string,
  facts: AuditFacts,
  evaluated: ReadonlyMap<number, EvaluatedControl>,
): boolean {
  const parent = parentOf(node, facts);
  return (
    parent !== undefined &&
    evaluated.get(parent.index)?.role === role &&
    facts.children.get(parent.index)?.length === 1
  );
}

/** Drops the findings the parent reports itself, so the pair speaks once, through the parent. */
function dropFindingsInto(
  parent: SnapshotNode,
  parentRole: string,
  findings: AuditFinding[],
  scan: AuditScan,
  rule: SizeRule,
): AuditFinding[] {
  const parentKinds = new Set(
    controlFindings(parent, parentRole, scan, rule).map(({ kind }) => kind),
  );
  return findings.filter(({ kind }) => !parentKinds.has(kind));
}

/** The nearest evaluated role-less clickable ancestor of a node, stopping at any control. */
function touchableContainerAncestor(node: SnapshotNode, scan: AuditScan): SnapshotNode | undefined {
  let current = parentOf(node, scan);
  while (current) {
    if (scan.evaluated.get(current.index)?.role === ANDROID_TOUCHABLE_ROLE) return current;
    if (scan.evaluated.has(current.index)) return undefined;
    current = parentOf(current, scan);
  }
  return undefined;
}

/** Whether the container's one and only actionable descendant is this node. */
function isSoleActionableDescendant(
  container: SnapshotNode,
  node: SnapshotNode,
  scan: AuditScan,
): boolean {
  const actionable = collectDescendants(scan.children, container.index).filter((descendant) =>
    scan.evaluated.has(descendant.index),
  );
  return actionable.length === 1 && actionable[0]?.index === node.index;
}

function controlRole(node: SnapshotNode): string | undefined {
  const type = normalizeType(node.type ?? '');
  return CONTROL_ROLES.find(([suffix]) => type.endsWith(suffix))?.[1];
}

/** The role a node is audited as: its control role, else the Android tap fact on a role-less node. */
function auditRole(node: SnapshotNode, facts: AuditFacts): string | undefined {
  return controlRole(node) ?? androidTouchableRole(node, facts);
}

/**
 * Android reports a custom touchable — a React Native Pressable without an accessibilityRole —
 * as clickable or long-clickable with no control class, so the tap fact is what makes it a
 * control. Other platforms publish no tap fact on their regular nodes, so they stay role-only.
 */
function androidTouchableRole(node: SnapshotNode, facts: AuditFacts): string | undefined {
  if (facts.platform !== 'android') return undefined;
  return node.clickable === true || node.longClickable === true
    ? ANDROID_TOUCHABLE_ROLE
    : undefined;
}

type ControlOwnership = 'app' | 'platform-sized' | 'system';

function controlOwnership(node: SnapshotNode, scan: AuditFacts): ControlOwnership {
  if (node.systemBar !== undefined || node.keyboardOwned === true) return 'system';
  if (scan.platform !== 'ios') return 'app';
  if (node.role === '_UIGrabber' || node.subrole === '_UIGrabber') return 'system';
  const parent = parentOf(node, scan);
  return parent && isNativeIosSnapshotBarNode(parent, scan.producer) ? 'platform-sized' : 'app';
}

function isActionable(node: SnapshotNode, ownership: ControlOwnership): boolean {
  return (
    isPositiveFiniteRect(node.rect) &&
    ownership !== 'system' &&
    node.enabled !== false &&
    node.visibleToUser !== false &&
    node.hittable !== false &&
    node.interactionBlocked === undefined
  );
}

function parentOf(node: SnapshotNode, scan: AuditFacts): SnapshotNode | undefined {
  return node.parentIndex === undefined ? undefined : scan.byIndex.get(node.parentIndex);
}

/** A link inside a text container keeps the text's own line height. */
function isInlineLink(node: SnapshotNode, role: string, scan: AuditFacts): boolean {
  const parent = parentOf(node, scan);
  return role === 'link' && parent !== undefined && isTextNode(parent);
}

function isTextNode(node: SnapshotNode): boolean {
  const role = formatRole(node.type ?? '');
  return role === 'text' || role === 'text-view';
}

function resolveSizeRule(context: AuditContext): SizeRule {
  if (context.target !== undefined && context.target !== 'mobile') {
    return unchecked(
      `${context.target} targets are focus-driven, so touch target size does not apply.`,
    );
  }
  if (context.platform === 'ios') {
    return { kind: 'checked', unit: 'pt', recommended: IOS_TARGET_PT, scale: 1 };
  }
  if (context.platform !== 'android') {
    return unchecked(`${context.platform} rects are not in points or dp.`);
  }
  if (!(context.pixelDensity && context.pixelDensity > 0)) {
    return unchecked(
      'this Android capture did not report display density, so pixels cannot become dp.',
    );
  }
  return {
    kind: 'checked',
    unit: 'dp',
    recommended: ANDROID_TARGET_DP,
    scale: 1 / context.pixelDensity,
  };
}

function unchecked(reason: string): SizeRule {
  return { kind: 'unchecked', limitation: `Target size was not checked: ${reason}` };
}

function collectLimitations(context: AuditContext, rule: SizeRule): string[] {
  const limitations = rule.kind === 'unchecked' ? [rule.limitation] : [];
  if (context.truncated === true) {
    limitations.push('The snapshot was truncated, so controls past the cut were not audited.');
  }
  if (context.truncated === undefined) {
    limitations.push('This capture cannot report truncation, so controls may be missing.');
  }
  return limitations;
}

function smallTargetFinding(
  node: SnapshotNode,
  role: string,
  rule: SizeRule,
): AuditFinding | undefined {
  if (rule.kind !== 'checked' || !isPositiveFiniteRect(node.rect)) return undefined;
  const width = node.rect.width * rule.scale;
  const height = node.rect.height * rule.scale;
  const floor = rule.recommended - SIZE_TOLERANCE;
  if (width >= floor && height >= floor) return undefined;
  return {
    ...findingBase(node, role),
    kind: 'small-target',
    severity: 'warning',
    detail: {
      unit: rule.unit,
      width: roundTenth(width),
      height: roundTenth(height),
      recommendedSize: rule.recommended,
    },
  };
}

function missingNameFinding(node: SnapshotNode, role: string): AuditFinding {
  const { label: _label, ...base } = findingBase(node, role);
  return { ...base, kind: 'missing-name', severity: 'warning' };
}

/**
 * Two or more evaluated controls of this role carry the same normalized name, so neither the
 * screen-reader user nor an agent can pick one by name. The detail spells the name as this
 * control exposes it.
 */
function ambiguousNameFinding(
  node: SnapshotNode,
  role: string,
  name: string | undefined,
  scan: AuditScan,
): AuditFinding | undefined {
  if (name === undefined) return undefined;
  const count = scan.sharedNames.get(nameGroupKey(role, name));
  if (count === undefined) return undefined;
  return {
    ...findingBase(node, role),
    kind: 'ambiguous-name',
    severity: 'warning',
    detail: { name, count },
  };
}

/**
 * The occlusion pass already decided this node is covered. Only controls and rows are reported,
 * and the sole child of a covered control or row collapses into that parent, which reports.
 */
function coveredFinding(node: SnapshotNode, scan: AuditScan): AuditFinding | undefined {
  const role = coveredRole(node, scan);
  if (node.interactionBlocked !== 'covered' || role === undefined) return undefined;
  if (isScrollRevealedByCover(node)) return undefined;
  if (isOnlyChildOfReportedCover(node, scan)) return undefined;
  return { ...findingBase(node, role), kind: 'covered-control', severity: 'observation' };
}

/**
 * A persistent bar over scrollable content does not block the node for good: when the scan
 * published `scrollCanReveal` on the cover, a scroll can reveal the node clear of the bar, so the
 * audit stays silent. Only this advisory finding drops; the touch refusal still stands at the
 * current scroll position. `scrollCanReveal` is only ever set on a persistent-bar cover.
 */
function isScrollRevealedByCover(node: SnapshotNode): boolean {
  return node.coveredBy?.scrollCanReveal === true;
}

function coveredRole(node: SnapshotNode, scan: AuditScan): string | undefined {
  if (node.interactionBlocked !== 'covered') return undefined;
  return auditRole(node, scan) ?? (isRow(node) ? 'cell' : undefined);
}

function isRow(node: SnapshotNode): boolean {
  return normalizeType(node.type ?? '').endsWith('cell');
}

function isOnlyChildOfReportedCover(node: SnapshotNode, scan: AuditScan): boolean {
  const parent = parentOf(node, scan);
  if (!parent || parent.ref === undefined || coveredRole(parent, scan) === undefined) return false;
  return scan.children.get(parent.index)?.length === 1;
}

function findingBase(node: SnapshotNode, role: string) {
  return {
    ref: `@${node.ref}`,
    ...(node.rect ? { rect: node.rect } : {}),
    role,
    ...(node.label?.trim() ? { label: node.label.trim() } : {}),
    ...(node.identifier?.trim() ? { identifier: node.identifier.trim() } : {}),
  };
}

/**
 * How this control is named: its own label, content description, or a field hint, else a named
 * descendant such as the text inside a button. None means no accessible name.
 */
function accessibleName(node: SnapshotNode, role: string, scan: AuditFacts): string | undefined {
  const own = ownName(node, EDITABLE_ROLES.has(role));
  if (own !== undefined) return own;
  if (EDITABLE_ROLES.has(role)) return undefined;
  return collectDescendants(scan.children, node.index)
    .map((child) => ownName(child, false))
    .find((name) => name !== undefined);
}

function ownName(node: SnapshotNode, editable: boolean): string | undefined {
  const typed = editable ? typedContent(node) : undefined;
  const candidates = [node.label, node.contentDescription, node.text];
  if (editable) candidates.push(node.placeholder);
  return candidates
    .map((candidate) => candidate?.trim())
    .find(
      (name) =>
        name !== undefined && name !== '' && name !== typed && !GENERIC_RESOURCE_ID.test(name),
    );
}

/** A field value is content the user typed unless it is the placeholder showing. */
function typedContent(node: SnapshotNode): string | undefined {
  const value = node.value?.trim();
  if (!value || node.hintShowing === true || value === node.placeholder?.trim()) return undefined;
  return value;
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function auditGuidance(
  findings: readonly AuditFinding[],
  context: AuditContext,
): AuditResult['guidance'] {
  const size =
    context.platform === 'ios' ? 'Apple HIG recommends 44×44pt.' : 'Material recommends 48×48dp.';
  const sentences: Record<AuditFindingKind, string> = {
    'small-target': `${size} Enlarge the touch area with padding, a minimum size, or hitSlop.`,
    'missing-name':
      'Set an accessibility label (iOS accessibilityLabel, Android contentDescription, React Native accessibilityLabel).',
    'ambiguous-name':
      'Give each control a unique label that names its target, for example "Save Lemon Herb Rice".',
    'covered-control':
      'Move the control out from under the cover. If the cover can be dismissed, such as a sheet or dialog, dismiss it before you use the control.',
  };
  return Object.fromEntries(findings.map(({ kind }) => [kind, sentences[kind]]));
}

/**
 * Attach a ref only when the frame identifies exactly one captured element. A native `hitRegion`
 * finding on the frame of a heuristic `small-target` finding is dropped: the heuristic one names
 * the same defect with a ref and the measured size.
 */
export function matchNativeAuditFindings(
  findings: readonly NativeAuditFinding[],
  nodes: readonly SnapshotNode[],
  heuristicFindings: readonly AuditFinding[],
): NativeAuditFinding[] {
  const smallTargetRects = heuristicFindings.flatMap((finding) =>
    finding.kind === 'small-target' && finding.rect ? [finding.rect] : [],
  );
  const unreported = findings.filter(
    ({ auditType, rect }) =>
      auditType !== 'hitRegion' ||
      rect === undefined ||
      !smallTargetRects.some((reported) => isSameFrame(reported, rect)),
  );
  const facts: AuditFacts = {
    platform: 'ios',
    producer: undefined,
    byIndex: new Map(nodes.map((node) => [node.index, node])),
    children: buildChildrenByParent(nodes),
  };
  return unreported.map((finding) => {
    const rect = finding.rect;
    if (!rect) return finding;
    const matches = nodes.filter(
      (node) => node.ref !== undefined && node.rect && isSameFrame(node.rect, rect),
    );
    const node = matches.length === 1 ? matches[0] : undefined;
    if (!node) return finding;
    const role = formatRole(node.type ?? 'Element');
    const label = accessibleName(node, role, facts);
    return { ...finding, ref: `@${node.ref}`, role, ...(label ? { label } : {}) };
  });
}

function isSameFrame(a: Rect, b: Rect): boolean {
  return (
    Math.abs(a.x - b.x) <= SIZE_TOLERANCE &&
    Math.abs(a.y - b.y) <= SIZE_TOLERANCE &&
    Math.abs(a.width - b.width) <= SIZE_TOLERANCE &&
    Math.abs(a.height - b.height) <= SIZE_TOLERANCE
  );
}
