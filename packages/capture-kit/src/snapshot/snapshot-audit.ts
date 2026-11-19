import type {
  AuditChecks,
  AuditContext,
  AuditFinding,
  AuditFindingKind,
  AuditResult,
  AuditSizeUnit,
} from '@agent-device/contracts/capture';
import { isNativeIosSnapshotBarNode, normalizeType } from '@agent-device/contracts/snapshot';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import { formatRole, type SnapshotNode } from '@agent-device/kernel/snapshot';
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
  const role = controlRole(node);
  if (role === undefined || node.ref === undefined) return undefined;
  const ownership = controlOwnership(node, facts);
  if (!isActionable(node, ownership)) return undefined;
  return { role, ownership, name: accessibleName(node, role, facts) };
}

/** Counts logical controls per name group: one control exposed twice counts once. */
function countSharedNames(
  nodes: readonly SnapshotNode[],
  evaluated: ReadonlyMap<number, EvaluatedControl>,
  facts: AuditFacts,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const control = evaluated.get(node.index);
    if (control?.name === undefined || isDuplicateExposure(node, control.role, facts, evaluated))
      continue;
    const group = nameGroupKey(control.role, control.name);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return new Map([...counts].filter(([, count]) => count > 1));
}

function snapshotCompleteness(context: AuditContext): AuditChecks['snapshot'] {
  if (context.truncated === undefined) return 'unknown';
  return context.truncated ? 'partial' : 'complete';
}

function auditNode(node: SnapshotNode, scan: AuditScan, rule: SizeRule): AuditFinding[] {
  if (node.ref === undefined) return [];
  const role = controlRole(node);
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
 */
function collapseIntoParent(
  node: SnapshotNode,
  role: string,
  findings: AuditFinding[],
  scan: AuditScan,
  rule: SizeRule,
): AuditFinding[] {
  const parent = parentOf(node, scan);
  if (!parent || !isDuplicateExposure(node, role, scan, scan.evaluated)) return findings;
  const parentKinds = new Set(controlFindings(parent, role, scan, rule).map(({ kind }) => kind));
  return findings.filter(({ kind }) => !parentKinds.has(kind));
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

function controlRole(node: SnapshotNode): string | undefined {
  const type = normalizeType(node.type ?? '');
  return CONTROL_ROLES.find(([suffix]) => type.endsWith(suffix))?.[1];
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
function coveredFinding(node: SnapshotNode, scan: AuditFacts): AuditFinding | undefined {
  const role = coveredRole(node);
  if (node.interactionBlocked !== 'covered' || role === undefined) return undefined;
  if (isOnlyChildOfReportedCover(node, scan)) return undefined;
  return { ...findingBase(node, role), kind: 'covered-control', severity: 'observation' };
}

function coveredRole(node: SnapshotNode): string | undefined {
  if (node.interactionBlocked !== 'covered') return undefined;
  return controlRole(node) ?? (isRow(node) ? 'cell' : undefined);
}

function isRow(node: SnapshotNode): boolean {
  return normalizeType(node.type ?? '').endsWith('cell');
}

function isOnlyChildOfReportedCover(node: SnapshotNode, scan: AuditFacts): boolean {
  const parent = parentOf(node, scan);
  if (!parent || parent.ref === undefined || coveredRole(parent) === undefined) return false;
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
