export const MAESTRO_COMPAT_SUPPORTED_CAPABILITIES = [
  'app launch with Apple-platform launch arguments and Android/iOS simulator clearState',
  'runFlow file/inline with when.platform, when.visible, when.notVisible, and limited when.true boolean/platform expressions',
  'onFlowStart and onFlowComplete hooks',
  'deterministic repeat.times and retry blocks',
  'tapOn including index, childOf, label, and absolute/percentage point taps',
  'doubleTapOn and longPressOn',
  'optional target and assertion commands',
  'inputText and focused-field eraseText',
  'openLink',
  'visibility assertions including childOf and extendedWaitUntil',
  'scroll and scrollUntilVisible',
  'absolute/percentage swipe and swipe.label',
  'screenshots',
  'keyboard dismiss',
  'basic pressKey, back, animation waits, and stopApp',
  'ordered trusted runScript file/env scripts with http.post, json, and output variables',
] as const;

export const MAESTRO_COMPAT_TRACKER_URL = 'https://github.com/callstack/agent-device/issues/558';

export function formatMaestroSupportedSubsetForCli(): string {
  return `Supported subset: ${formatMaestroCapabilityList(MAESTRO_COMPAT_SUPPORTED_CAPABILITIES)}.`;
}

export function formatMaestroCapabilityList(capabilities: readonly string[]): string {
  return capabilities.length > 1
    ? `${capabilities.slice(0, -1).join(', ')}, and ${capabilities.at(-1)}`
    : (capabilities[0] ?? '');
}
