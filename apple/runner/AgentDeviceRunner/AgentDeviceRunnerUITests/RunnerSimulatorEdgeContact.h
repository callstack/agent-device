#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <TargetConditionals.h>
#import <mach/mach_time.h>

// One simulator edge contact, from its reserved terminal event to touch-up. Every declaration here
// has internal linkage, so the runner exports none of it; RunnerSimulatorEdgeTouch.m and its unit
// tests each compile their own copy.

#if TARGET_OS_IOS && TARGET_OS_SIMULATOR

NS_ASSUME_NONNULL_BEGIN

typedef CFTypeRef RunnerHIDEventRef;
typedef RunnerHIDEventRef _Nullable (*RunnerCreateDigitizerEvent)(
  CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, double, double,
  double, double, double, Boolean, Boolean, uint32_t);
typedef RunnerHIDEventRef _Nullable (*RunnerCreateDigitizerFingerEvent)(
  CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t, double, double, double, double, double,
  Boolean, Boolean, uint32_t);
typedef void (*RunnerAppendEvent)(RunnerHIDEventRef, RunnerHIDEventRef, uint32_t);
typedef void (*RunnerSetIntegerValue)(RunnerHIDEventRef, uint32_t, long);
typedef void (*RunnerSetFloatValue)(RunnerHIDEventRef, uint32_t, double);
typedef void (*RunnerSetSenderID)(RunnerHIDEventRef, uint64_t);
typedef void (*RunnerSetTimeStamp)(RunnerHIDEventRef, uint64_t);
typedef CFTypeRef _Nullable (*RunnerCreateEventSystemClient)(CFAllocatorRef);
typedef CFArrayRef _Nullable (*RunnerCopyServices)(CFTypeRef);
typedef CFTypeRef _Nullable (*RunnerCopyServiceProperty)(CFTypeRef, CFStringRef);
typedef CFTypeRef _Nullable (*RunnerGetServiceRegistryID)(CFTypeRef);
typedef void (*RunnerDispatchEvent)(CFTypeRef, RunnerHIDEventRef);

// The IOKit HID entry points the edge touch uses, resolved at run time.
typedef struct {
  RunnerCreateDigitizerEvent createDigitizerEvent;
  RunnerCreateDigitizerFingerEvent createFingerEvent;
  RunnerAppendEvent appendEvent;
  RunnerSetIntegerValue setIntegerValue;
  RunnerSetFloatValue setFloatValue;
  RunnerSetSenderID setSenderID;
  RunnerSetTimeStamp setTimeStamp;
  RunnerCreateEventSystemClient createClient;
  RunnerCopyServices copyServices;
  RunnerCopyServiceProperty copyServiceProperty;
  RunnerGetServiceRegistryID getServiceRegistryID;
  RunnerDispatchEvent dispatchEvent;
} RunnerHIDFunctions;

// IOHIDDigitizerEventMask bits (IOHIDFamily IOHIDEventTypes.h). A real edge swipe on a simulator
// carries Range/Touch/Position plus SwipeLocked and the swipe direction on every frame.
static const uint32_t RunnerDigitizerRange = 1u << 0;
static const uint32_t RunnerDigitizerTouch = 1u << 1;
static const uint32_t RunnerDigitizerPosition = 1u << 2;
static const uint32_t RunnerDigitizerCancel = 1u << 7;
static const uint32_t RunnerDigitizerSwipeLocked = 1u << 18;
static const uint32_t RunnerDigitizerSwipeUp = 1u << 24;
static const uint32_t RunnerDigitizerSwipeDown = 1u << 25;
static const uint32_t RunnerDigitizerSwipeLeft = 1u << 26;
static const uint32_t RunnerDigitizerSwipeRight = 1u << 27;

// IOHIDEventField values of the digitizer event type (11).
static const uint32_t RunnerDigitizerFieldMajorRadius = (11u << 16) | 20u;
static const uint32_t RunnerDigitizerFieldMinorRadius = (11u << 16) | 21u;
static const uint32_t RunnerDigitizerFieldIsDisplayIntegrated = (11u << 16) | 25u;

static const uint32_t RunnerTransducerHand = 3;
static const uint32_t RunnerFingerIdentity = 2;
static const double RunnerFingerRadius = 0.04;
static const double RunnerFingerPressure = 0.5;
static const double RunnerFrameIntervalMs = 16.0;

// One retained hand event with its finger, or NULL when either could not be created.
static inline RunnerHIDEventRef _Nullable RunnerCreateFrame(
  const RunnerHIDFunctions *functions,
  uint64_t sender,
  CGPoint normalized,
  uint32_t mask,
  Boolean touching
) {
  uint64_t timestamp = mach_absolute_time();
  RunnerHIDEventRef hand = functions->createDigitizerEvent(
    kCFAllocatorDefault, timestamp, RunnerTransducerHand, 0, 0, mask, 0,
    normalized.x, normalized.y, 0, 0, 0, touching, touching, 0);
  RunnerHIDEventRef finger = functions->createFingerEvent(
    kCFAllocatorDefault, timestamp, 1, RunnerFingerIdentity, mask, normalized.x, normalized.y, 0,
    touching ? RunnerFingerPressure : 0, 0, touching, touching, 0);
  if (hand == NULL || finger == NULL) {
    if (hand != NULL) CFRelease(hand);
    if (finger != NULL) CFRelease(finger);
    return NULL;
  }
  functions->setIntegerValue(hand, RunnerDigitizerFieldIsDisplayIntegrated, 1);
  functions->setFloatValue(finger, RunnerDigitizerFieldMajorRadius, RunnerFingerRadius);
  functions->setFloatValue(finger, RunnerDigitizerFieldMinorRadius, RunnerFingerRadius);
  functions->appendEvent(hand, finger, 0);
  CFRelease(finger);
  functions->setSenderID(hand, sender);
  return hand;
}

static inline void RunnerDispatchAndRelease(const RunnerHIDFunctions *functions, CFTypeRef client, RunnerHIDEventRef event) {
  functions->dispatchEvent(client, event);
  CFRelease(event);
}

static inline CGPoint RunnerSamplePoint(NSDictionary<NSString *, NSNumber *> *sample, CGSize screenSize) {
  return CGPointMake(sample[@"x"].doubleValue / screenSize.width, sample[@"y"].doubleValue / screenSize.height);
}

// The swipe direction the system reports for a contact moving from `start` to `end`, in the
// display's native axes, where y grows downward.
static inline uint32_t RunnerSwipeDirection(CGPoint start, CGPoint end) {
  double dx = end.x - start.x;
  double dy = end.y - start.y;
  if (fabs(dx) >= fabs(dy)) return dx >= 0 ? RunnerDigitizerSwipeRight : RunnerDigitizerSwipeLeft;
  return dy >= 0 ? RunnerDigitizerSwipeDown : RunnerDigitizerSwipeUp;
}

// The contact position at `offsetMs`, interpolated between the planned samples.
static inline CGPoint RunnerPointAtOffset(
  NSArray<NSDictionary<NSString *, NSNumber *> *> *samples,
  double offsetMs,
  CGSize screenSize
) {
  for (NSUInteger index = 1; index < samples.count; index++) {
    NSDictionary<NSString *, NSNumber *> *end = samples[index];
    if (offsetMs > end[@"offsetMs"].doubleValue) continue;
    NSDictionary<NSString *, NSNumber *> *start = samples[index - 1];
    double startOffset = start[@"offsetMs"].doubleValue;
    double span = end[@"offsetMs"].doubleValue - startOffset;
    double progress = span > 0 ? (offsetMs - startOffset) / span : 1;
    CGPoint from = RunnerSamplePoint(start, screenSize);
    CGPoint to = RunnerSamplePoint(end, screenSize);
    return CGPointMake(from.x + (to.x - from.x) * progress, from.y + (to.y - from.y) * progress);
  }
  return RunnerSamplePoint(samples.lastObject, screenSize);
}

// The contact position at `offsetMs` when it eases in quadratically along the planned path.
static inline CGPoint RunnerEasedPoint(
  NSArray<NSDictionary<NSString *, NSNumber *> *> *samples,
  double offsetMs,
  double durationMs,
  CGSize screenSize
) {
  double progress = durationMs > 0 ? offsetMs / durationMs : 1;
  return RunnerPointAtOffset(samples, durationMs * progress * progress, screenSize);
}

static inline void RunnerWaitUntil(uint64_t startTicks, double offsetMs) {
  static mach_timebase_info_data_t timebase;
  if (timebase.denom == 0) mach_timebase_info(&timebase);
  uint64_t nanoseconds = (uint64_t)(offsetMs * NSEC_PER_MSEC);
  mach_wait_until(startTicks + nanoseconds * timebase.denom / timebase.numer);
}

// Owns one edge contact from touch-down to its terminal event. The cancel event is built before
// touch-down; after touch-down, every exit dispatches either the touch-up or that cancel event.
// Returns nil on success, or the reason the contact did not complete.
static inline NSString * _Nullable RunnerDispatchEdgeContact(
  const RunnerHIDFunctions *functions,
  CFTypeRef client,
  uint64_t sender,
  NSArray<NSDictionary<NSString *, NSNumber *> *> *samples,
  CGSize screenSize
) {
  double durationMs = samples.lastObject[@"offsetMs"].doubleValue;
  CGPoint start = RunnerPointAtOffset(samples, 0, screenSize);
  uint32_t swipe = RunnerDigitizerSwipeLocked |
    RunnerSwipeDirection(start, RunnerPointAtOffset(samples, durationMs, screenSize));
  // The terminal event exists before touch-down, so a contact that goes down always ends.
  RunnerHIDEventRef cancel = RunnerCreateFrame(
    functions, sender, start, RunnerDigitizerRange | RunnerDigitizerTouch | RunnerDigitizerCancel | swipe, false);
  if (cancel == NULL) return @"simulator HID dispatch could not create the touch-cancel event";
  RunnerHIDEventRef down = RunnerCreateFrame(
    functions, sender, start, RunnerDigitizerRange | RunnerDigitizerTouch | RunnerDigitizerPosition | swipe, true);
  if (down == NULL) {
    CFRelease(cancel);
    return @"simulator HID dispatch could not create the touch-down event";
  }
  uint64_t startTicks = mach_absolute_time();
  RunnerDispatchAndRelease(functions, client, down);
  NSString *failure = nil;
  for (double offsetMs = RunnerFrameIntervalMs; offsetMs < durationMs + RunnerFrameIntervalMs;
       offsetMs += RunnerFrameIntervalMs) {
    double frameOffset = MIN(offsetMs, durationMs);
    RunnerWaitUntil(startTicks, frameOffset);
    // The edge recognizer fails when the first move leaves the edge region in one frame, as a fast
    // finger does on a wide panel, so the contact eases in like a real swipe.
    RunnerHIDEventRef move = RunnerCreateFrame(
      functions, sender, RunnerEasedPoint(samples, frameOffset, durationMs, screenSize),
      RunnerDigitizerPosition | swipe, true);
    if (move == NULL) {
      failure = @"simulator HID dispatch could not create a touch-move event; the contact was cancelled";
      break;
    }
    RunnerDispatchAndRelease(functions, client, move);
  }
  if (failure == nil) {
    RunnerWaitUntil(startTicks, durationMs + RunnerFrameIntervalMs);
    RunnerHIDEventRef lift = RunnerCreateFrame(
      functions, sender, RunnerPointAtOffset(samples, durationMs, screenSize),
      RunnerDigitizerRange | RunnerDigitizerTouch | swipe, false);
    if (lift != NULL) {
      RunnerDispatchAndRelease(functions, client, lift);
      CFRelease(cancel);
      return nil;
    }
    failure = @"simulator HID dispatch could not create the touch-up event; the contact was cancelled";
  }
  functions->setTimeStamp(cancel, mach_absolute_time());
  RunnerDispatchAndRelease(functions, client, cancel);
  return failure;
}

NS_ASSUME_NONNULL_END

#endif
