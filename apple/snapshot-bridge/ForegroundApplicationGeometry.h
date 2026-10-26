// ForegroundApplicationGeometry.h — the one full-screen rule the Simulator snapshot bridge and
// the iOS runner both include, by bare name, so the rule is one compilation and not a pinned
// copy. Each keeps its own unknown policy: the bridge keeps a capture it cannot measure, the
// runner refuses to authorize a route it cannot prove.

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
