// ForegroundApplicationGeometry.h — the one full-screen rule two native targets ask.
//
// The Simulator snapshot bridge refuses a capture whose app window does not fill the screen
// (`app-window-not-full-screen`, #3844), and the iOS runner refuses to route a window-less
// gesture onto a screen it cannot prove the app fills. Both include this header, so the rule is
// one compilation, not a pinned copy. Each caller keeps its own unknown policy: the bridge keeps
// a capture it cannot measure, the runner refuses authorization it cannot prove.
//
// The Simulator snapshot bridge includes this file directly; the runner's event bridge includes
// it as `../../../snapshot-bridge/ForegroundApplicationGeometry.h`, which resolves to this file
// from the checkout (`apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/`) and, through the
// mirror `scripts/package-apple-runner-source.mjs` writes, from the installed package
// (`dist/apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/`) alike.

#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <math.h>

NS_ASSUME_NONNULL_BEGIN

@protocol AgentDeviceForegroundElement <NSObject>
+ (nullable id<AgentDeviceForegroundElement>)primaryApp;
+ (nullable id<AgentDeviceForegroundElement>)systemApplication;
- (pid_t)pid;
- (CGRect)frame;
@end

// While a system surface owns the foreground, no screen is the target app's to fill and no tree is
// the target app's to capture (ADR 0004, foreground ownership).
static inline BOOL AgentDeviceForegroundOwnershipMatches(pid_t primaryProcessID, pid_t targetProcessID) {
  return primaryProcessID == targetProcessID;
}

// Sub-pixel layout rounding is not a window; anything past this is one that shows the app in part
// of the screen (Windowed Apps or Stage Manager).
#define AGENT_DEVICE_FULL_SCREEN_FRAME_TOLERANCE 0.5

// A null, empty, infinite-sentinel, or non-finite-component frame is not a measurement at all: it
// proves neither the fill nor the window, so it must reach each caller's unknown policy, never a
// comparison that reads as a difference. This is the whole usability test; callers make one call.
static inline BOOL AgentDeviceForegroundFrameIsMeasurable(CGRect frame) {
  if (CGRectIsNull(frame) || CGRectIsEmpty(frame) || CGRectIsInfinite(frame)) return NO;
  return isfinite(frame.origin.x) && isfinite(frame.origin.y) &&
      isfinite(frame.size.width) && isfinite(frame.size.height);
}

static inline BOOL AgentDeviceForegroundFramesAreMeasurable(CGRect window, CGRect screen) {
  return AgentDeviceForegroundFrameIsMeasurable(window) &&
      AgentDeviceForegroundFrameIsMeasurable(screen);
}

static inline BOOL AgentDeviceForegroundWindowFillsScreen(CGRect window, CGRect screen) {
  return fabs(window.origin.x - screen.origin.x) <= AGENT_DEVICE_FULL_SCREEN_FRAME_TOLERANCE &&
      fabs(window.origin.y - screen.origin.y) <= AGENT_DEVICE_FULL_SCREEN_FRAME_TOLERANCE &&
      fabs(window.size.width - screen.size.width) <= AGENT_DEVICE_FULL_SCREEN_FRAME_TOLERANCE &&
      fabs(window.size.height - screen.size.height) <= AGENT_DEVICE_FULL_SCREEN_FRAME_TOLERANCE;
}

NS_ASSUME_NONNULL_END
