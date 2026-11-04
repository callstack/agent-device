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

// The simulator touchscreen HID service: digitizer usage page, touch screen usage.
static const long RunnerDigitizerUsagePage = 13;
static const long RunnerTouchScreenUsage = 4;

static inline long RunnerServiceIntegerProperty(
  const RunnerHIDFunctions *functions,
  CFTypeRef service,
  CFStringRef key
) {
  CFTypeRef value = functions->copyServiceProperty(service, key);
  long result = -1;
  if (value != NULL && CFGetTypeID(value) == CFNumberGetTypeID()) {
    CFNumberGetValue((CFNumberRef)value, kCFNumberLongType, &result);
  }
  if (value != NULL) CFRelease(value);
  return result;
}

static inline NSString * _Nullable RunnerServiceStringProperty(
  const RunnerHIDFunctions *functions,
  CFTypeRef service,
  CFStringRef key
) {
  CFTypeRef value = functions->copyServiceProperty(service, key);
  NSString *result = nil;
  if (value != NULL && CFGetTypeID(value) == CFStringGetTypeID()) {
    result = [(__bridge NSString *)value copy];
  }
  if (value != NULL) CFRelease(value);
  return result;
}

// How a service property reads: absent, present with a type other than the one asked for, or present.
typedef NS_ENUM(NSInteger, RunnerServicePropertyRead) {
  RunnerServicePropertyMissing,
  RunnerServicePropertyUnexpectedType,
  RunnerServicePropertyPresent,
};

static inline RunnerServicePropertyRead RunnerReadServiceStringProperty(
  const RunnerHIDFunctions *functions,
  CFTypeRef service,
  CFStringRef key,
  NSString * _Nullable __autoreleasing * _Nonnull value
) {
  *value = nil;
  CFTypeRef property = functions->copyServiceProperty(service, key);
  if (property == NULL) return RunnerServicePropertyMissing;
  RunnerServicePropertyRead read = RunnerServicePropertyUnexpectedType;
  if (CFGetTypeID(property) == CFStringGetTypeID()) {
    *value = [(__bridge NSString *)property copy];
    read = RunnerServicePropertyPresent;
  }
  CFRelease(property);
  return read;
}

// Touches reach the app only with its display's touchscreen service as their sender. A candidate is
// a touchscreen (digitizer usage page, touch screen usage) on the app's display with a readable
// registry ID. A simulator client names its service's Transport `CoreDevice`, one service per
// attached client; the oldest, created at boot, is always present and wins. Some simulator hosts
// name no Transport at all; their display's only candidate is its touchscreen, and several are
// ambiguous.
static inline NSString * _Nullable RunnerSelectTouchscreenSender(
  const RunnerHIDFunctions *functions,
  CFTypeRef client,
  NSString * _Nullable displayUUID,
  NSUInteger displayID,
  uint64_t *sender
) {
  NSUInteger touchscreens = 0;
  NSUInteger onDisplay = 0;
  NSUInteger coreDevice = 0;
  NSUInteger transportMissing = 0;
  NSUInteger transportOtherType = 0;
  NSUInteger transportOtherValue = 0;
  uint64_t oldestCoreDevice = 0;
  uint64_t otherCandidate = 0;
  CFArrayRef services = functions->copyServices(client);
  for (CFIndex index = 0; services != NULL && index < CFArrayGetCount(services); index++) {
    CFTypeRef service = CFArrayGetValueAtIndex(services, index);
    if (RunnerServiceIntegerProperty(functions, service, CFSTR("PrimaryUsagePage")) != RunnerDigitizerUsagePage ||
        RunnerServiceIntegerProperty(functions, service, CFSTR("PrimaryUsage")) != RunnerTouchScreenUsage) {
      continue;
    }
    touchscreens += 1;
    NSString *serviceDisplayUUID = RunnerServiceStringProperty(functions, service, CFSTR("displayUUID"));
    if (serviceDisplayUUID != displayUUID && ![serviceDisplayUUID isEqualToString:displayUUID]) continue;
    onDisplay += 1;
    CFTypeRef registryID = functions->getServiceRegistryID(service);
    uint64_t candidate = 0;
    if (registryID == NULL || CFGetTypeID(registryID) != CFNumberGetTypeID() ||
        !CFNumberGetValue((CFNumberRef)registryID, kCFNumberSInt64Type, &candidate)) {
      continue;
    }
    NSString *transport = nil;
    switch (RunnerReadServiceStringProperty(functions, service, CFSTR("Transport"), &transport)) {
      case RunnerServicePropertyPresent:
        if ([transport isEqualToString:@"CoreDevice"]) {
          if (coreDevice == 0 || candidate < oldestCoreDevice) oldestCoreDevice = candidate;
          coreDevice += 1;
          continue;
        }
        transportOtherValue += 1;
        break;
      case RunnerServicePropertyMissing:
        transportMissing += 1;
        break;
      case RunnerServicePropertyUnexpectedType:
        transportOtherType += 1;
        break;
    }
    otherCandidate = candidate;
  }
  if (services != NULL) CFRelease(services);
  NSUInteger others = transportMissing + transportOtherType + transportOtherValue;
  if (coreDevice > 0) {
    *sender = oldestCoreDevice;
    return nil;
  }
  if (others == 1) {
    *sender = otherCandidate;
    return nil;
  }
  if (others > 1) {
    return [NSString stringWithFormat:
      @"display %lu has %lu touchscreen HID services without a CoreDevice transport "
      @"(missing: %lu, other type: %lu, other value: %lu), so an edge touch cannot choose one",
      (unsigned long)displayID, (unsigned long)others, (unsigned long)transportMissing,
      (unsigned long)transportOtherType, (unsigned long)transportOtherValue];
  }
  return [NSString stringWithFormat:
    @"display %lu has no simulator touchscreen HID service: %lu touchscreen service%@, %lu on this "
    @"display, 0 with a readable registry ID",
    (unsigned long)displayID, (unsigned long)touchscreens, touchscreens == 1 ? @"" : @"s",
    (unsigned long)onDisplay];
}

NS_ASSUME_NONNULL_END

#endif
