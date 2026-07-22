import type { Rect } from '../../kernel/snapshot.ts';

export type AndroidFillVerificationNode = {
  text: string | null;
  className: string | null;
  resourceId: string | null;
  packageName: string | null;
  rect: Rect;
  focused: boolean;
  password: boolean;
  inputMethodOwned: boolean;
  area: number;
};

export type FillFailureReason = 'ime_capture' | 'masked_unverified' | 'text_mismatch';

export type AndroidFillVerification = {
  ok: boolean;
  actual: string | null;
  reason?: FillFailureReason;
  masked?: boolean;
  targetInput: AndroidFillVerificationNode | null;
  actualInput: AndroidFillVerificationNode | null;
};

export type FillDiagnosticDetailsNode = Omit<AndroidFillVerificationNode, 'text'> & {
  text: string | null;
  textRedacted?: true;
};

type FillFailureDetailsBase = {
  failureReason: FillFailureReason;
  targetInput: FillDiagnosticDetailsNode | null;
  actualInput: FillDiagnosticDetailsNode | null;
  hint?: string;
};

type UnmaskedFillFailureDetails = FillFailureDetailsBase & {
  expected: string;
  expectedLength?: never;
  actual: string | null;
  masked?: never;
  actualLength?: never;
};

type MaskedFillFailureDetails = FillFailureDetailsBase & {
  expected?: never;
  expectedLength: number;
  actual: null;
  masked: true;
  actualLength: number;
};

export type FillFailureDetails = UnmaskedFillFailureDetails | MaskedFillFailureDetails;

export function buildFillFailureDetails(
  expected: string,
  verification: AndroidFillVerification | null,
): FillFailureDetails {
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

export function isSensitiveFillDiagnosticNode(node: AndroidFillVerificationNode | null): boolean {
  if (!node) return false;
  if (node.password) return true;
  return isMaskedFillText(node.text);
}

function isMaskedFillText(text: string | null | undefined): boolean {
  if (!text) return false;
  return Array.from(text).every(isMaskCharacter);
}

function toFillDiagnosticNode(
  node: AndroidFillVerificationNode | null,
): FillDiagnosticDetailsNode | null {
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
  return char === '•' || char === '*' || char === '●';
}

function isSensitiveFillVerification(verification: AndroidFillVerification): boolean {
  return (
    verification.masked === true ||
    isSensitiveFillDiagnosticNode(verification.targetInput) ||
    isSensitiveFillDiagnosticNode(verification.actualInput)
  );
}
