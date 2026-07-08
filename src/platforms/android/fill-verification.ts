import type { DeviceInfo } from '../../kernel/device.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import type { Rect } from '../../kernel/snapshot.ts';
import {
  buildFillFailureDetails,
  type FillFailureDetails,
  type FillDiagnosticNode,
  type FillVerification,
  isSensitiveFillDiagnosticNode,
} from '../fill-diagnostics.ts';
import { sleep } from './adb.ts';
import { getAndroidKeyboardState } from './device-input-state.ts';
import { isAndroidInputMethodOwnedNode } from '../../core/android-input-ownership.ts';
import { captureAndroidUiHierarchyXml } from './snapshot.ts';
import { androidUiNodes, type AndroidUiNodeMetadata } from './ui-hierarchy.ts';

export type AndroidFillVerificationNode = FillDiagnosticNode & {
  className: string | null;
  resourceId: string | null;
  packageName: string | null;
  rect: Rect;
  focused: boolean;
  password: boolean;
  inputMethodOwned: boolean;
  area: number;
};

export type AndroidFillVerification = FillVerification<AndroidFillVerificationNode>;

type AndroidFillVerificationCandidate = AndroidFillVerificationNode & {
  editText: boolean;
};

type AndroidTextAtPointInspection = {
  targetInput: AndroidFillVerificationNode | null;
  actualInput: AndroidFillVerificationNode | null;
};

type AndroidTextAtPointScan = {
  focusedEdit: AndroidFillVerificationCandidate | null;
  editAtPoint: AndroidFillVerificationCandidate | null;
  anyAtPoint: AndroidFillVerificationCandidate | null;
};

type AndroidFillVerificationContext = {
  activeInputMethodPackage?: string | null;
};

export async function verifyAndroidFilledText(
  device: DeviceInfo,
  x: number,
  y: number,
  expected: string,
): Promise<AndroidFillVerification> {
  const verificationDelaysMs = [0, 150, 350];
  let lastVerification: AndroidFillVerification | null = null;
  let stableVerification: AndroidFillVerification | null = null;
  const context = await readAndroidFillVerificationContext(device);

  for (const delayMs of verificationDelaysMs) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    const verification = await inspectAndroidFilledText(device, x, y, expected, context);
    lastVerification = verification;
    if (verification.reason === 'ime_capture') {
      return verification;
    }
    if (verification.ok) {
      stableVerification = verification;
    } else {
      stableVerification = null;
    }
  }

  return (
    stableVerification ??
    lastVerification ?? {
      ok: false,
      actual: null,
      reason: 'text_mismatch',
      targetInput: null,
      actualInput: null,
    }
  );
}

export async function readAndroidTextAtPoint(
  device: DeviceInfo,
  x: number,
  y: number,
): Promise<string | null> {
  return readAndroidTextAtPointInHierarchy(await captureAndroidUiHierarchyXml(device), x, y);
}

export function verifyAndroidFilledTextInHierarchy(
  xml: string,
  x: number,
  y: number,
  expected: string,
  context: AndroidFillVerificationContext = {},
): AndroidFillVerification {
  const inspection = inspectAndroidTextAtPointInHierarchy(xml, x, y, context);
  if (isAndroidImeCapture(inspection)) {
    return {
      ok: false,
      actual: inspection.actualInput?.text ?? null,
      reason: 'ime_capture',
      targetInput: inspection.targetInput,
      actualInput: inspection.actualInput,
    };
  }

  return (
    maskedAndroidFillVerification(inspection, expected) ??
    textAndroidFillVerification(inspection, expected)
  );
}

export function readAndroidTextAtPointInHierarchy(
  xml: string,
  x: number,
  y: number,
): string | null {
  return inspectAndroidTextAtPointInHierarchy(xml, x, y).actualInput?.text ?? null;
}

export function androidFillFailureMessage(verification: AndroidFillVerification | null): string {
  if (verification?.reason === 'ime_capture') {
    return 'Android fill input was captured by the active keyboard instead of the app field';
  }
  if (verification?.reason === 'masked_unverified') {
    return 'Android fill verification could not confirm masked text value';
  }
  return 'Android fill verification failed';
}

export function androidFillFailureDetails(
  expected: string,
  verification: AndroidFillVerification | null,
): FillFailureDetails<AndroidFillVerificationNode> {
  const details = buildFillFailureDetails(expected, verification);
  if (verification?.reason === 'ime_capture') {
    details.hint =
      'The focused input belongs to the Android keyboard/IME, not the app field. Disable handwriting/stylus input or switch to a standard IME, then retry fill.';
  }
  return details;
}

async function inspectAndroidFilledText(
  device: DeviceInfo,
  x: number,
  y: number,
  expected: string,
  context: AndroidFillVerificationContext,
): Promise<AndroidFillVerification> {
  return verifyAndroidFilledTextInHierarchy(
    await captureAndroidUiHierarchyXml(device),
    x,
    y,
    expected,
    context,
  );
}

function inspectAndroidTextAtPointInHierarchy(
  xml: string,
  x: number,
  y: number,
  context: AndroidFillVerificationContext = {},
): AndroidTextAtPointInspection {
  const scan: AndroidTextAtPointScan = {
    focusedEdit: null,
    editAtPoint: null,
    anyAtPoint: null,
  };

  for (const node of androidUiNodes(xml)) {
    const candidate = androidFillCandidateFromNode(node, context);
    if (candidate) updateAndroidTextAtPointScan(scan, candidate, x, y);
  }

  return androidTextAtPointInspection(scan);
}

function isAndroidImeCapture(inspection: AndroidTextAtPointInspection): boolean {
  const { targetInput, actualInput } = inspection;
  if (!targetInput || !actualInput) return false;
  if (actualInput === targetInput) return false;
  return actualInput.inputMethodOwned && !targetInput.inputMethodOwned;
}

function maskedAndroidFillVerification(
  inspection: AndroidTextAtPointInspection,
  expected: string,
): AndroidFillVerification | null {
  const actualInput = inspection.actualInput;
  if (!actualInput || !isMaskedAndroidInput(actualInput)) return null;
  const actual = actualInput.text ?? null;
  const actualLength = Array.from(actual ?? '').length;
  const expectedLength = Array.from(expected).length;
  const matched =
    actual !== null && actualLength > 0 && expectedLength > 0 && actualLength === expectedLength;
  return {
    ok: matched,
    actual,
    reason: matched ? undefined : 'masked_unverified',
    masked: true,
    targetInput: inspection.targetInput,
    actualInput,
  };
}

function textAndroidFillVerification(
  inspection: AndroidTextAtPointInspection,
  expected: string,
): AndroidFillVerification {
  const actual = inspection.actualInput?.text ?? null;
  return {
    ok: isAcceptableAndroidFillMatch(actual, expected),
    actual,
    reason: 'text_mismatch',
    targetInput: inspection.targetInput,
    actualInput: inspection.actualInput,
  };
}

function isAcceptableAndroidFillMatch(actual: string | null, expected: string): boolean {
  if (actual === expected) {
    return true;
  }
  const normalizedActual = normalizeFillVerificationText(actual);
  const normalizedExpected = normalizeFillVerificationText(expected);
  if (!normalizedActual || !normalizedExpected) {
    return false;
  }
  if (normalizedActual === normalizedExpected) {
    return true;
  }
  if (isSentenceAutocapitalizeMatch(normalizedActual, normalizedExpected)) {
    return true;
  }
  return false;
}

function normalizeFillVerificationText(value: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function isSentenceAutocapitalizeMatch(actual: string, expected: string): boolean {
  if (actual.length !== expected.length || actual.length === 0) return false;
  if (actual.slice(1) !== expected.slice(1)) return false;
  const actualFirst = actual[0];
  const expectedFirst = expected[0];
  if (!actualFirst || !expectedFirst) return false;
  return (
    expectedFirst.toLowerCase() === expectedFirst && actualFirst === expectedFirst.toUpperCase()
  );
}

function androidFillCandidateFromNode(
  node: AndroidUiNodeMetadata,
  context: AndroidFillVerificationContext,
): AndroidFillVerificationCandidate | null {
  if (!node.rect) return null;
  const text = node.text ?? '';
  const area = Math.max(1, node.rect.width * node.rect.height);
  return {
    text: text || null,
    className: node.className,
    resourceId: node.resourceId,
    packageName: node.packageName,
    rect: node.rect,
    focused: node.focused ?? false,
    password: node.password === true,
    inputMethodOwned: isAndroidInputMethodOwnedNode({
      packageName: node.packageName,
      resourceId: node.resourceId,
      activeInputMethodPackage: context.activeInputMethodPackage,
    }),
    area,
    editText: isEditTextClass(node.className ?? ''),
  };
}

async function readAndroidFillVerificationContext(
  device: DeviceInfo,
): Promise<AndroidFillVerificationContext> {
  try {
    const state = await getAndroidKeyboardState(device);
    return { activeInputMethodPackage: state.inputMethodPackage };
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'android_fill_verification_input_method_probe_failed',
      data: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return {};
  }
}

function updateAndroidTextAtPointScan(
  scan: AndroidTextAtPointScan,
  candidate: AndroidFillVerificationCandidate,
  x: number,
  y: number,
): void {
  const containsPoint = containsAndroidPoint(candidate.rect, x, y);
  if (containsPoint && candidate.editText) {
    scan.editAtPoint = smallerAndroidFillCandidate(scan.editAtPoint, candidate);
  }
  if (candidate.focused && candidate.editText) {
    scan.focusedEdit = smallerAndroidFillCandidate(scan.focusedEdit, candidate);
    return;
  }
  if (containsPoint && candidate.text) {
    scan.anyAtPoint = smallerAndroidFillCandidate(scan.anyAtPoint, candidate);
  }
}

function containsAndroidPoint(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

function smallerAndroidFillCandidate<T extends AndroidFillVerificationCandidate>(
  current: T | null,
  next: T,
): T {
  return current && current.area < next.area ? current : next;
}

function androidTextAtPointInspection(scan: AndroidTextAtPointScan): AndroidTextAtPointInspection {
  const targetInput = scan.editAtPoint ?? scan.anyAtPoint;
  const focusedInput = scan.focusedEdit?.text ? scan.focusedEdit : null;
  return {
    targetInput,
    actualInput: focusedInput ?? targetInput,
  };
}

function isEditTextClass(className: string): boolean {
  const lower = className.toLowerCase();
  return lower.includes('edittext') || lower.includes('textfield');
}

function isMaskedAndroidInput(node: AndroidFillVerificationNode): boolean {
  return isSensitiveFillDiagnosticNode(node);
}
