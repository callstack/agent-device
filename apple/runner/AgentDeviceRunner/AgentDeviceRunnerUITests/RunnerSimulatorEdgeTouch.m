#import "RunnerSimulatorEdgeTouch.h"

#if TARGET_OS_IOS && TARGET_OS_SIMULATOR

#import "RunnerSimulatorEdgeContact.h"
#import "RunnerXCTestEventBridge.h"
#import <dlfcn.h>
#import <objc/message.h>

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
    { (void **)&functions->setTimeStamp, "IOHIDEventSetTimeStamp" },
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

// Touches reach the app only with its display's touchscreen service as their sender. A display has
// one service per attached simulator client; the oldest, created at boot, is always present.
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
    uint64_t candidate = 0;
    if (registryID == NULL || CFGetTypeID(registryID) != CFNumberGetTypeID() ||
        !CFNumberGetValue((CFNumberRef)registryID, kCFNumberSInt64Type, &candidate)) {
      continue;
    }
    if (matches == 0 || candidate < *sender) *sender = candidate;
    matches += 1;
  }
  if (services != NULL) CFRelease(services);
  if (matches > 0) return nil;
  return [NSString stringWithFormat:@"display %lu has no simulator touchscreen HID service",
                                    (unsigned long)displayID];
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

  failure = RunnerDispatchEdgeContact(&functions, client, sender, samples, screenSize);
  CFRelease(client);
  return failure;
}

@end

#endif
