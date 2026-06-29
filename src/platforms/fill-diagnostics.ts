import type { Rect } from '../kernel/snapshot.ts';

/**
 * Cross-platform metadata for fill verification diagnostics.
 *
 * Platform backends should populate whichever native identity fields they have:
 * iOS/macOS usually use `identifier`, Android uses `resourceId` and `packageName`.
 */
export type FillDiagnosticNode = {
  text: string | null;
  className?: string | null;
  identifier?: string | null;
  resourceId?: string | null;
  packageName?: string | null;
  rect?: Rect | null;
  focused?: boolean;
  password?: boolean;
  inputMethodOwned?: boolean;
};

export type FillFailureReason = 'ime_capture' | 'masked_unverified' | 'text_mismatch';

export type FillVerification<TNode extends FillDiagnosticNode = FillDiagnosticNode> = {
  ok: boolean;
  actual: string | null;
  reason?: FillFailureReason;
  masked?: boolean;
  targetInput: TNode | null;
  actualInput: TNode | null;
};

export type FillDiagnosticDetailsNode<TNode extends FillDiagnosticNode = FillDiagnosticNode> = Omit<
  TNode,
  'text'
> & {
  text: string | null;
  textRedacted?: true;
};

type FillFailureDetailsBase<TNode extends FillDiagnosticNode> = {
  failureReason: FillFailureReason;
  targetInput: FillDiagnosticDetailsNode<TNode> | null;
  actualInput: FillDiagnosticDetailsNode<TNode> | null;
  hint?: string;
};

type UnmaskedFillFailureDetails<TNode extends FillDiagnosticNode> =
  FillFailureDetailsBase<TNode> & {
    expected: string;
    expectedLength?: never;
    actual: string | null;
    masked?: never;
    actualLength?: never;
  };

type MaskedFillFailureDetails<TNode extends FillDiagnosticNode> = FillFailureDetailsBase<TNode> & {
  expected?: never;
  expectedLength: number;
  actual: null;
  masked: true;
  actualLength: number;
};

export type FillFailureDetails<TNode extends FillDiagnosticNode = FillDiagnosticNode> =
  | UnmaskedFillFailureDetails<TNode>
  | MaskedFillFailureDetails<TNode>;

export function buildFillFailureDetails<TNode extends FillDiagnosticNode>(
  expected: string,
  verification: FillVerification<TNode> | null,
): FillFailureDetails<TNode> {
  if (!verification) {
    return {
      expected,
      actual: null,
      failureReason: 'text_mismatch',
      targetInput: null,
      actualInput: null,
    };
  }

  const sensitive = isSensitiveFillVerification(verification);
  const common = {
    failureReason: verification.reason ?? 'text_mismatch',
    targetInput: toFillDiagnosticNode(verification.targetInput),
    actualInput: toFillDiagnosticNode(verification.actualInput),
  };
  if (sensitive) {
    return {
      ...common,
      expectedLength: Array.from(expected).length,
      actual: null,
      masked: true,
      actualLength: Array.from(verification.actual ?? '').length,
    };
  }
  return {
    ...common,
    expected,
    actual: verification.actual,
  };
}

export function isSensitiveFillDiagnosticNode(node: FillDiagnosticNode | null): boolean {
  if (!node) return false;
  if (node.password) return true;
  return isMaskedFillText(node.text);
}

function isMaskedFillText(text: string | null | undefined): boolean {
  if (!text) return false;
  return Array.from(text).every(isMaskCharacter);
}

function toFillDiagnosticNode<TNode extends FillDiagnosticNode>(
  node: TNode | null,
): FillDiagnosticDetailsNode<TNode> | null {
  if (!node) return null;
  const textRedacted = isSensitiveFillDiagnosticNode(node);
  return {
    ...node,
    text: textRedacted ? null : node.text,
    ...(textRedacted ? { textRedacted: true } : {}),
  };
}

function isMaskCharacter(char: string): boolean {
  // Deliberately conservative: expand this allowlist only for observed platform masks.
  return char === '\u2022' || char === '*' || char === '\u25cf';
}

function isSensitiveFillVerification(verification: FillVerification): boolean {
  return (
    verification.masked === true ||
    isSensitiveFillDiagnosticNode(verification.targetInput) ||
    isSensitiveFillDiagnosticNode(verification.actualInput)
  );
}
