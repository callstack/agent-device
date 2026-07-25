export const LOG_ACTION_VALUES = ['path', 'start', 'stop', 'doctor', 'mark', 'clear'] as const;
export type LogAction = (typeof LOG_ACTION_VALUES)[number];

/**
 * Which platform-family log backend serves a device. Declared here rather than in the
 * daemon because `core/platform-plugin/plugin.ts` types its `appLog` facet with it: the
 * plugin names the backend, the daemon owns the backend objects.
 */
export type LogBackend = 'ios-simulator' | 'ios-device' | 'android' | 'macos';
