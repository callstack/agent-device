import type {
  AppStateCommandResult,
  ClipboardCommandResult,
  KeyboardCommandResult,
} from '../../client/client-types.ts';
import type { CliOutput } from '../command-contract.ts';
import {
  messageCliOutput,
  messageOutput,
  resultOutput,
  type CliOutputFormatter,
} from '../output-common.ts';

function appStateCliOutput(result: AppStateCommandResult): CliOutput {
  return {
    data: result,
    text: formatAppState(result),
  };
}

// fallow-ignore-next-line complexity
function keyboardCliOutput(result: KeyboardCommandResult): CliOutput {
  if (result.platform === 'android' && result.action === 'status') {
    const lines = [
      `Keyboard visible: ${result.visible === true ? 'yes' : 'no'}`,
      `Input type: ${result.type ?? result.inputType ?? 'unknown'}`,
      `Input owner: ${result.inputOwner ?? 'unknown'}`,
    ];
    if (result.inputMethodPackage) lines.push(`Input method: ${result.inputMethodPackage}`);
    if (result.focusedPackage) lines.push(`Focused package: ${result.focusedPackage}`);
    if (result.focusedResourceId) lines.push(`Focused resource: ${result.focusedResourceId}`);
    lines.push(`Next action: ${androidKeyboardNextAction(result.visible, result.inputOwner)}`);
    return { data: result, text: lines.join('\n') };
  }
  return messageCliOutput(result);
}

function clipboardCliOutput(result: ClipboardCommandResult): CliOutput {
  if (result.action === 'read') return { data: result, text: result.text };
  return messageCliOutput(result);
}

export const systemCliOutputFormatters = {
  appstate: resultOutput(appStateCliOutput),
  back: messageOutput,
  home: messageOutput,
  orientation: messageOutput,
  'app-switcher': messageOutput,
  keyboard: resultOutput(keyboardCliOutput),
  clipboard: resultOutput(clipboardCliOutput),
  'tv-remote': messageOutput,
} as const satisfies Record<string, CliOutputFormatter>;

function formatAppState(data: AppStateCommandResult): string | null {
  if (data.platform === 'ios') {
    const lines = [`Foreground app: ${data.appName ?? data.appBundleId ?? 'unknown'}`];
    if (data.appBundleId) lines.push(`Bundle: ${data.appBundleId}`);
    if (data.source) lines.push(`Source: ${data.source}`);
    return lines.join('\n');
  }
  if (data.platform === 'android') {
    const lines = [`Foreground app: ${data.package ?? 'unknown'}`];
    if (data.activity) lines.push(`Activity: ${data.activity}`);
    return lines.join('\n');
  }
  return null;
}

function androidKeyboardNextAction(
  visible: boolean | undefined,
  inputOwner: KeyboardCommandResult['inputOwner'],
): string {
  if (inputOwner === 'ime') {
    return 'Focused input appears to be owned by the keyboard/IME; dismiss or change the IME before retrying text entry.';
  }
  if (visible === true) {
    return 'Keyboard is visible and focused input appears app-owned; fill/type can proceed.';
  }
  return 'Keyboard is hidden; focus an app field before type, or use fill with a concrete target.';
}
