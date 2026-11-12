#import "RunnerSimulatorEdgeTouch.h"

#if TARGET_OS_IOS && TARGET_OS_SIMULATOR

#import "RunnerSimulatorEdgeContact.h"
#import "RunnerXCTestEventBridge.h"
#import <dlfcn.h>
#import <objc/message.h>

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

static NSString * _Nullable RunnerResolveTouchscreenSender(
  const RunnerHIDFunctions *functions,
  CFTypeRef client,
  NSUInteger displayID,
  uint64_t *sender
) {
  NSString *selection = nil;
  NSString *failure = RunnerSelectTouchscreenSender(
    functions, client, RunnerDisplayUUID(displayID), displayID, sender, &selection);
  if (failure == nil) {
    NSLog(@"AGENT_DEVICE_RUNNER_EDGE_TOUCHSCREEN display=%lu %@", (unsigned long)displayID, selection);
  }
  return failure;
}

@implementation RunnerSimulatorEdgeTouch {
  RunnerHIDFunctions _functions;
  CFTypeRef _client;
  uint64_t _sender;
}

+ (nullable instancetype)prepareWithApplication:(id)application
                                 resolvedWindow:(id _Nullable)resolvedWindow
                                        failure:(NSString * _Nullable __autoreleasing * _Nonnull)failure {
  *failure = nil;
  NSUInteger displayID = 0;
  id soleScreen = nil;
  NSString *displayError = resolvedWindow == nil
    ? RunnerResolveSoleScreen(application, &soleScreen, &displayID)
    : RunnerResolveWindowDisplayID(resolvedWindow, &displayID);
  if (displayError != nil) {
    *failure = displayError;
    return nil;
  }
  RunnerHIDFunctions functions = {0};
  NSString *hidError = RunnerResolveHIDFunctions(&functions);
  if (hidError != nil) {
    *failure = hidError;
    return nil;
  }
  CFTypeRef client = functions.createClient(kCFAllocatorDefault);
  if (client == NULL) {
    *failure = @"simulator HID dispatch is unavailable: no event system client";
    return nil;
  }
  uint64_t sender = 0;
  NSString *senderError = RunnerResolveTouchscreenSender(&functions, client, displayID, &sender);
  if (senderError != nil) {
    CFRelease(client);
    *failure = senderError;
    return nil;
  }
  RunnerSimulatorEdgeTouch *touch = [[self alloc] initWithFunctions:functions client:client sender:sender];
  CFRelease(client);
  return touch;
}

- (instancetype)initWithFunctions:(RunnerHIDFunctions)functions client:(CFTypeRef)client sender:(uint64_t)sender {
  if ((self = [super init])) {
    _functions = functions;
    _client = CFRetain(client);
    _sender = sender;
  }
  return self;
}

- (void)dealloc {
  CFRelease(_client);
}

- (NSString * _Nullable)dispatchSamples:(NSArray<NSDictionary<NSString *, NSNumber *> *> *)samples
                             screenSize:(CGSize)screenSize
                              touchDown:(BOOL *)touchDown {
  *touchDown = NO;
  if (samples.count < 2 || screenSize.width <= 0 || screenSize.height <= 0) {
    return @"an edge touch needs at least two samples and a measured screen";
  }
  return RunnerDispatchEdgeContact(&_functions, _client, _sender, samples, screenSize, touchDown);
}

@end

#endif
