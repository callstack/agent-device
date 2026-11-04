/** A persisted Android recording descriptor for recovery tests. */
export const androidRecordingDescriptorFixture = Object.freeze({
  backend: 'adb-screenrecord',
  manifestPath: '/data/local/tmp/agent-device-recording-active.json',
  outputPath: '/tmp/capture.mp4',
  scope: 'device',
  showTouches: true,
  recordOnlySession: false,
  transportMode: 'local',
} as const);
