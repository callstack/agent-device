#import "RunnerSimulatorEdgeTouch.h"

#if TARGET_OS_IOS && TARGET_OS_SIMULATOR

#import "RunnerXCTestEventBridge.h"
#import <dlfcn.h>
#import <mach/mach_time.h>
#import <objc/message.h>

typedef CFTypeRef RunnerHIDEventRef;
typedef RunnerHIDEventRef (*RunnerCreateDigitizerEvent)(
  CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, double, double,
  double, double, double, Boolean, Boolean, uint32_t);
typedef RunnerHIDEventRef (*RunnerCreateDigitizerFingerEvent)(
  CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t, double, double, double, double, double,
  Boolean, Boolean, uint32_t);
typedef void (*RunnerAppendEvent)(RunnerHIDEventRef, RunnerHIDEventRef, uint32_t);
typedef void (*RunnerSetIntegerValue)(RunnerHIDEventRef, uint32_t, long);
typedef void (*RunnerSetFloatValue)(RunnerHIDEventRef, uint32_t, double);
typedef void (*RunnerSetSenderID)(RunnerHIDEventRef, uint64_t);
typedef CFTypeRef (*RunnerCreateEventSystemClient)(CFAllocatorRef);
typedef CFArrayRef (*RunnerCopyServices)(CFTypeRef);
typedef CFTypeRef (*RunnerCopyServiceProperty)(CFTypeRef, CFStringRef);
typedef CFTypeRef (*RunnerGetServiceRegistryID)(CFTypeRef);
typedef void (*RunnerDispatchEvent)(CFTypeRef, RunnerHIDEventRef);

typedef struct {
  RunnerCreateDigitizerEvent createDigitizerEvent;
  RunnerCreateDigitizerFingerEvent createFingerEvent;
  RunnerAppendEvent appendEvent;
  RunnerSetIntegerValue setIntegerValue;
  RunnerSetFloatValue setFloatValue;
  RunnerSetSenderID setSenderID;
  RunnerCreateEventSystemClient createClient;
  RunnerCopyServices copyServices;
  RunnerCopyServiceProperty copyServiceProperty;
  RunnerGetServiceRegistryID getServiceRegistryID;
  RunnerDispatchEvent dispatchEvent;
} RunnerHIDFunctions;

// IOHIDDigitizerEventMask bits.
static const uint32_t RunnerDigitizerRange = 1u << 0;
static const uint32_t RunnerDigitizerTouch = 1u << 1;
static const uint32_t RunnerDigitizerPosition = 1u << 2;
static const uint32_t RunnerDigitizerIdentity = 1u << 5;
static const uint32_t RunnerDigitizerFromEdgeFlat = 1u << 10;
static const uint32_t RunnerDigitizerFromEdgeTip = 1u << 11;
static const uint32_t RunnerDigitizerEdgeMask = RunnerDigitizerFromEdgeFlat | RunnerDigitizerFromEdgeTip;

// IOHIDEventField values of the digitizer event type (11).
static const uint32_t RunnerDigitizerFieldMajorRadius = (11u << 16) | 20u;
static const uint32_t RunnerDigitizerFieldMinorRadius = (11u << 16) | 21u;
static const uint32_t RunnerDigitizerFieldIsDisplayIntegrated = (11u << 16) | 25u;

static const uint32_t RunnerTransducerHand = 3;
static const uint32_t RunnerFingerIdentity = 2;
static const double RunnerFingerRadius = 0.04;
static const double RunnerFingerPressure = 0.5;
static const double RunnerFrameIntervalMs = 16.0;

// The simulator touchscreen HID service: digitizer usage page, touch screen usage.
static const long RunnerDigitizerUsagePage = 13;
static const long RunnerTouchScreenUsage = 4;

static NSString * _Nullable RunnerResolveHIDFunctions(RunnerHIDFunctions *functions) {
  void *iokit = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW);
  if (iokit == NULL) {
    return @"simulator HID dispatch is unavailable: IOKit could not be loaded";
  }
  struct { void **slot; const char *name; } symbols[] = {
    { (void **)&functions->createDigitizerEvent, "IOHIDEventCreateDigitizerEvent" },
    { (void **)&functions->createFingerEvent, "IOHIDEventCreateDigitizerFingerEvent" },
    { (void **)&functions->appendEvent, "IOHIDEventAppendEvent" },
    { (void **)&functions->setIntegerValue, "IOHIDEventSetIntegerValue" },
    { (void **)&functions->setFloatValue, "IOHIDEventSetFloatValue" },
    { (void **)&functions->setSenderID, "IOHIDEventSetSenderID" },
    { (void **)&functions->createClient, "IOHIDEventSystemClientCreate" },
    { (void **)&functions->copyServices, "IOHIDEventSystemClientCopyServices" },
    { (void **)&functions->copyServiceProperty, "IOHIDServiceClientCopyProperty" },
    { (void **)&functions->getServiceRegistryID, "IOHIDServiceClientGetRegistryID" },
    { (void **)&functions->dispatchEvent, "IOHIDEventSystemClientDispatchEvent" },
  };
  for (size_t index = 0; index < sizeof(symbols) / sizeof(symbols[0]); index++) {
    *symbols[index].slot = dlsym(iokit, symbols[index].name);
    if (*symbols[index].slot == NULL) {
      return [NSString stringWithFormat:@"simulator HID dispatch is unavailable: %s is missing",
                                        symbols[index].name];
    }
  }
  return nil;
}

static long RunnerServiceIntegerProperty(
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

static NSString * _Nullable RunnerServiceStringProperty(
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

// The display UUID that a touchscreen HID service names for `displayID`, the XCTest display ID.
// A simulator runtime that gives its displays no UUID answers nil, and so do its touchscreens.
static NSString * _Nullable RunnerDisplayUUID(NSUInteger displayID) {
  Class displayClass = NSClassFromString(@"CADisplay");
  SEL displaysSelector = NSSelectorFromString(@"displays");
  SEL displayIdSelector = NSSelectorFromString(@"displayId");
  SEL uniqueIdSelector = NSSelectorFromString(@"uniqueId");
  if (displayClass == Nil || ![displayClass respondsToSelector:displaysSelector]) return nil;
  NSArray *displays = ((id (*)(id, SEL))objc_msgSend)(displayClass, displaysSelector);
  for (id display in displays) {
    if (![display respondsToSelector:displayIdSelector] || ![display respondsToSelector:uniqueIdSelector]) continue;
    if (((unsigned int (*)(id, SEL))objc_msgSend)(display, displayIdSelector) != displayID) continue;
    id uniqueId = ((id (*)(id, SEL))objc_msgSend)(display, uniqueIdSelector);
    return [uniqueId isKindOfClass:[NSString class]] ? uniqueId : nil;
  }
  return nil;
}

// Touches reach the app only with its display's touchscreen service as their sender.
static NSString * _Nullable RunnerResolveTouchscreenSender(
  const RunnerHIDFunctions *functions,
  CFTypeRef client,
  NSUInteger displayID,
  uint64_t *sender
) {
  NSString *displayUUID = RunnerDisplayUUID(displayID);
  CFArrayRef services = functions->copyServices(client);
  NSUInteger matches = 0;
  for (CFIndex index = 0; services != NULL && index < CFArrayGetCount(services); index++) {
    CFTypeRef service = CFArrayGetValueAtIndex(services, index);
    if (RunnerServiceIntegerProperty(functions, service, CFSTR("PrimaryUsagePage")) != RunnerDigitizerUsagePage ||
        RunnerServiceIntegerProperty(functions, service, CFSTR("PrimaryUsage")) != RunnerTouchScreenUsage ||
        ![RunnerServiceStringProperty(functions, service, CFSTR("Transport")) isEqualToString:@"CoreDevice"]) {
      continue;
    }
    NSString *serviceDisplayUUID = RunnerServiceStringProperty(functions, service, CFSTR("displayUUID"));
    if (serviceDisplayUUID != displayUUID && ![serviceDisplayUUID isEqualToString:displayUUID]) continue;
    CFTypeRef registryID = functions->getServiceRegistryID(service);
    if (registryID != NULL && CFGetTypeID(registryID) == CFNumberGetTypeID()) {
      CFNumberGetValue((CFNumberRef)registryID, kCFNumberSInt64Type, sender);
      matches += 1;
    }
  }
  if (services != NULL) CFRelease(services);
  if (matches == 1) return nil;
  return [NSString stringWithFormat:@"display %lu has %lu simulator touchscreen HID services; an edge touch needs exactly one",
                                    (unsigned long)displayID, (unsigned long)matches];
}

static void RunnerDispatchFrame(
  const RunnerHIDFunctions *functions,
  CFTypeRef client,
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
    return;
  }
  functions->setIntegerValue(hand, RunnerDigitizerFieldIsDisplayIntegrated, 1);
  functions->setFloatValue(finger, RunnerDigitizerFieldMajorRadius, RunnerFingerRadius);
  functions->setFloatValue(finger, RunnerDigitizerFieldMinorRadius, RunnerFingerRadius);
  functions->appendEvent(hand, finger, 0);
  functions->setSenderID(hand, sender);
  functions->dispatchEvent(client, hand);
  CFRelease(finger);
  CFRelease(hand);
}

static CGPoint RunnerSamplePoint(NSDictionary<NSString *, NSNumber *> *sample, CGSize screenSize) {
  return CGPointMake(sample[@"x"].doubleValue / screenSize.width, sample[@"y"].doubleValue / screenSize.height);
}

// The contact position at `offsetMs`, interpolated between the planned samples.
static CGPoint RunnerPointAtOffset(
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

static void RunnerWaitUntil(uint64_t startTicks, double offsetMs) {
  static mach_timebase_info_data_t timebase;
  if (timebase.denom == 0) mach_timebase_info(&timebase);
  uint64_t nanoseconds = (uint64_t)(offsetMs * NSEC_PER_MSEC);
  mach_wait_until(startTicks + nanoseconds * timebase.denom / timebase.numer);
}

@implementation RunnerSimulatorEdgeTouch

+ (NSString * _Nullable)dispatchWithApplication:(id)application
                                 resolvedWindow:(id _Nullable)resolvedWindow
                                        samples:(NSArray<NSDictionary<NSString *, NSNumber *> *> *)samples
                                     screenSize:(CGSize)screenSize {
  if (samples.count < 2 || screenSize.width <= 0 || screenSize.height <= 0) {
    return @"an edge touch needs at least two samples and a measured screen";
  }
  NSUInteger displayID = 0;
  id soleScreen = nil;
  NSString *displayError = resolvedWindow == nil
    ? RunnerResolveSoleScreen(application, &soleScreen, &displayID)
    : RunnerResolveWindowDisplayID(resolvedWindow, &displayID);
  if (displayError != nil) return displayError;
  RunnerHIDFunctions functions = {0};
  NSString *failure = RunnerResolveHIDFunctions(&functions);
  if (failure != nil) return failure;
  CFTypeRef client = functions.createClient(kCFAllocatorDefault);
  if (client == NULL) return @"simulator HID dispatch is unavailable: no event system client";
  uint64_t sender = 0;
  failure = RunnerResolveTouchscreenSender(&functions, client, displayID, &sender);
  if (failure != nil) {
    CFRelease(client);
    return failure;
  }

  double durationMs = samples.lastObject[@"offsetMs"].doubleValue;
  uint64_t startTicks = mach_absolute_time();
  RunnerDispatchFrame(
    &functions, client, sender, RunnerPointAtOffset(samples, 0, screenSize),
    RunnerDigitizerRange | RunnerDigitizerTouch | RunnerDigitizerIdentity | RunnerDigitizerEdgeMask, true);
  for (double offsetMs = RunnerFrameIntervalMs; offsetMs < durationMs + RunnerFrameIntervalMs;
       offsetMs += RunnerFrameIntervalMs) {
    double frameOffset = MIN(offsetMs, durationMs);
    RunnerWaitUntil(startTicks, frameOffset);
    RunnerDispatchFrame(
      &functions, client, sender, RunnerPointAtOffset(samples, frameOffset, screenSize),
      RunnerDigitizerPosition | RunnerDigitizerEdgeMask, true);
  }
  RunnerWaitUntil(startTicks, durationMs + RunnerFrameIntervalMs);
  RunnerDispatchFrame(
    &functions, client, sender, RunnerPointAtOffset(samples, durationMs, screenSize),
    RunnerDigitizerRange | RunnerDigitizerTouch | RunnerDigitizerIdentity, false);
  CFRelease(client);
  return nil;
}

@end

#endif
