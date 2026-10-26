#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <dlfcn.h>
#import <mach/mach_time.h>
#import <math.h>
#import <objc/message.h>

// Private simulator HID entry points. `set` only dispatches; `hinge` and `panels` only observe, so
// the host verifies a pose with a separate process that never sends HID.
extern CFDataRef IOCFSerialize(CFTypeRef object, CFOptionFlags options);
extern CFTypeRef IOHIDEventCreateVendorDefinedEvent(CFAllocatorRef allocator, uint64_t timestamp,
    uint32_t usagePage, uint32_t usage, uint32_t version, const uint8_t *data,
    CFIndex length, uint32_t options);
extern CFTypeRef IOHIDEventSystemClientCreate(CFAllocatorRef allocator);
extern void IOHIDEventSystemClientDispatchEvent(CFTypeRef client, CFTypeRef event);

static BOOL sendAngle(CFTypeRef client, double angle) {
  NSDictionary *payload = @{
    @"provider": @"com.apple.Virtualization.VirtualMachines",
    @"source": @"hinge-slider-control", @"type": @"range", @"value": @(angle),
  };
  CFDataRef data = IOCFSerialize((__bridge CFTypeRef)payload, 1);
  if (!data) return NO;
  CFTypeRef event = IOHIDEventCreateVendorDefinedEvent(kCFAllocatorDefault,
      mach_absolute_time(), 0xff61, 0x5b, 0, CFDataGetBytePtr(data), CFDataGetLength(data), 0);
  if (event) IOHIDEventSystemClientDispatchEvent(client, event);
  CFRelease(data);
  if (!event) return NO;
  CFRelease(event);
  return YES;
}

static BOOL validNumber(id value) {
  return [value isKindOfClass:NSNumber.class] &&
      CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID() && isfinite([value doubleValue]);
}

static NSArray *readFrames(NSString *argument) {
  NSNumber *preset = (@{@"closed": @0, @"half-open": @130, @"open": @180})[argument];
  if (preset) return @[@{@"atMs": @0, @"angle": preset}];
  id frames = [NSJSONSerialization JSONObjectWithData:[argument dataUsingEncoding:NSUTF8StringEncoding]
      options:0 error:NULL];
  if (![frames isKindOfClass:NSArray.class] || [frames count] < 2 || [frames count] > 64) return nil;
  double previous = -1;
  for (id frame in frames) {
    if (![frame isKindOfClass:NSDictionary.class] || [frame count] != 2 ||
        !validNumber(frame[@"atMs"]) || !validNumber(frame[@"angle"])) return nil;
    double time = [frame[@"atMs"] doubleValue], angle = [frame[@"angle"] doubleValue];
    if (time < 0 || time > 60000 || floor(time) != time || time <= previous ||
        (previous == -1 && time != 0) || angle < 0 || angle > 180) return nil;
    previous = time;
  }
  return frames;
}

static double angleAtTime(NSArray *frames, double elapsed) {
  NSUInteger segment = 0;
  while (segment + 1 < frames.count && [frames[segment + 1][@"atMs"] doubleValue] <= elapsed) segment++;
  double angle = [frames[segment][@"angle"] doubleValue];
  if (segment + 1 < frames.count) {
    double from = [frames[segment][@"atMs"] doubleValue];
    double to = [frames[segment + 1][@"atMs"] doubleValue];
    angle += ([frames[segment + 1][@"angle"] doubleValue] - angle) * (elapsed - from) / (to - from);
  }
  return angle;
}

static BOOL runFrames(CFTypeRef client, NSArray *frames) {
  mach_timebase_info_data_t clock;
  mach_timebase_info(&clock);
  uint64_t start = mach_absolute_time();
  double duration = [frames.lastObject[@"atMs"] doubleValue];
  double elapsed = 0;
  while (YES) {
    @autoreleasepool {
      if (!sendAngle(client, angleAtTime(frames, elapsed))) return NO;
    }
    if (elapsed >= duration) return YES;
    double now = (mach_absolute_time() - start) * clock.numer / (double)clock.denom / 1e6;
    // Absolute deadlines skip missed frames instead of extending the user's timeline.
    double next = fmin(duration, (floor(now * 60 / 1000) + 1) * 1000 / 60);
    mach_wait_until(start + (uint64_t)(next * 1e6 * clock.denom / clock.numer));
    elapsed = fmin(duration, (mach_absolute_time() - start) * clock.numer / (double)clock.denom / 1e6);
  }
}

static int runSet(NSString *argument) {
  NSArray *frames = readFrames(argument);
  if (!frames) {
    fprintf(stderr, "Expected a pose or 2-64 {atMs,angle} keyframes spanning 0 to at most 60000ms\n");
    return 2;
  }
  CFTypeRef client = IOHIDEventSystemClientCreate(kCFAllocatorDefault);
  if (!client) return 1;
  BOOL dispatched = runFrames(client, frames);
  CFRelease(client);
  if (!dispatched) fprintf(stderr, "Unable to create simulator HID event\n");
  return dispatched ? 0 : 1;
}

static BOOL responds(id target, SEL selector) {
  return target != nil && [target respondsToSelector:selector];
}

static id sendObject(id target, SEL selector) {
  return responds(target, selector) ? ((id (*)(id, SEL))objc_msgSend)(target, selector) : nil;
}

static id sendObjectWith(id target, SEL selector, id argument) {
  return responds(target, selector) ? ((id (*)(id, SEL, id))objc_msgSend)(target, selector, argument) : nil;
}

static BOOL printJSON(NSDictionary *payload) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:NULL];
  if (!data) return NO;
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  return YES;
}

// One fresh CoreMotion observation, the source devicectl's hinge-angle stream relays. The manager
// delivers the current angle on subscription and then each change, so after `windowMs` the latest
// sample is where the hinge is now. A window spaces two reads of a moving hinge apart in time.
static int readHinge(NSString *windowArgument) {
  NSInteger windowMs = windowArgument ? windowArgument.integerValue : 0;
  if (windowArgument && (windowMs < 0 || windowMs > 5000 ||
      ![[@(windowMs) stringValue] isEqualToString:windowArgument])) {
    fprintf(stderr, "Expected a hinge read window from 0 to 5000ms\n");
    return 2;
  }
  dlopen("/System/Library/Frameworks/CoreMotion.framework/CoreMotion", RTLD_NOW);
  Class managerClass = NSClassFromString(@"CMAngleManager");
  SEL start = @selector(startAngleUpdatesToQueue:handler:);
  if (!managerClass || !responds(managerClass, @selector(isAvailable)) ||
      !((BOOL (*)(id, SEL))objc_msgSend)(managerClass, @selector(isAvailable)) ||
      ![managerClass instancesRespondToSelector:start]) {
    fprintf(stderr, "CMAngleManager is not available in this simulator runtime\n");
    return 3;
  }
  id manager = [managerClass new];
  NSOperationQueue *queue = [NSOperationQueue new];
  queue.maxConcurrentOperationCount = 1;
  dispatch_semaphore_t sampled = dispatch_semaphore_create(0);
  __block BOOL received = NO;
  __block double angle = NAN;
  __block BOOL valid = NO;
  // The handler's second argument is not an object; the block declares only the sample.
  void (^handler)(id) = ^(id sample) {
    if (!responds(sample, @selector(angleDegrees))) return;
    angle = ((float (*)(id, SEL))objc_msgSend)(sample, @selector(angleDegrees));
    valid = responds(sample, @selector(isAngleValid)) &&
        ((BOOL (*)(id, SEL))objc_msgSend)(sample, @selector(isAngleValid));
    if (!received) dispatch_semaphore_signal(sampled);
    received = YES;
  };
  ((void (*)(id, SEL, NSOperationQueue *, id))objc_msgSend)(manager, start, queue, handler);
  long timedOut = dispatch_semaphore_wait(sampled, dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC));
  if (!timedOut && windowMs > 0) [NSThread sleepForTimeInterval:windowMs / 1000.0];
  if (responds(manager, @selector(stopAngleUpdates))) {
    ((void (*)(id, SEL))objc_msgSend)(manager, @selector(stopAngleUpdates));
  }
  [queue waitUntilAllOperationsAreFinished];
  if (timedOut) {
    fprintf(stderr, "CMAngleManager delivered no hinge sample within 3 seconds\n");
    return 4;
  }
  return printJSON(@{@"version": @1, @"angleDegrees": @(angle), @"angleValid": @(valid)}) ? 0 : 1;
}

// BacklightServices BLSBacklightState, named as CoreDevice's BacklightState union names it.
static NSString *backlightStateName(long state) {
  switch (state) {
    case 0: return @"off";
    case 1: return @"inactiveOn";
    case 2: return @"activeOn";
    case 3: return @"activeDimmed";
    default: return @"unknown";
  }
}

// The integrated panels in the shape of `devicectl device info displays`, read from the same guest
// sources dtdeviceinfod uses: CADisplay for identity and geometry, BLSBacklight for panel power.
// `integratedCount` counts every built-in panel, including one whose facts could not be read, so
// the host can tell a short table from a single-panel device.
static int readPanels(void) {
  dlopen("/System/Library/Frameworks/QuartzCore.framework/QuartzCore", RTLD_NOW);
  dlopen("/System/Library/PrivateFrameworks/BacklightServices.framework/BacklightServices", RTLD_NOW);
  Class displayClass = NSClassFromString(@"CADisplay");
  NSArray *displays = sendObject(displayClass, @selector(displays));
  if (![displays isKindOfClass:NSArray.class]) {
    fprintf(stderr, "CADisplay is not available in this simulator runtime\n");
    return 3;
  }
  Class backlightClass = NSClassFromString(@"BLSBacklight");
  Class referenceClass = NSClassFromString(@"BLSDisplayReference");
  id mainDisplay = sendObject(displayClass, @selector(mainDisplay));
  NSMutableArray *panels = [NSMutableArray array];
  NSUInteger integratedCount = 0;
  for (id display in displays) {
    if (!responds(display, @selector(displayType))) {
      fprintf(stderr, "CADisplay cannot classify its displays in this simulator runtime\n");
      return 5;
    }
    // displayType 0 is a built-in panel; TVOut, wireless and resizable ports are not.
    if (((long (*)(id, SEL))objc_msgSend)(display, @selector(displayType)) != 0) continue;
    if (responds(display, @selector(isExternal)) &&
        ((BOOL (*)(id, SEL))objc_msgSend)(display, @selector(isExternal))) continue;
    integratedCount += 1;
    if (!responds(display, @selector(nativeSize)) || !responds(display, @selector(pointScale)) ||
        !responds(display, @selector(displayId))) continue;
    CGSize size = ((CGSize (*)(id, SEL))objc_msgSend)(display, @selector(nativeSize));
    NSString *name = sendObject(display, @selector(name));
    if (size.width <= 0 || size.height <= 0 || ![name isKindOfClass:NSString.class]) continue;
    id reference = sendObjectWith(referenceClass, @selector(referenceForCADisplay:), display);
    id backlight = reference ? sendObjectWith(backlightClass, @selector(sharedBacklightForDisplay:), reference) : nil;
    NSString *backlightState = responds(backlight, @selector(backlightState))
        ? backlightStateName(((long (*)(id, SEL))objc_msgSend)(backlight, @selector(backlightState)))
        : @"unknown";
    NSString *orientation = sendObject(display, @selector(currentOrientation));
    [panels addObject:@{
      @"name": name,
      @"displayId": @(((unsigned (*)(id, SEL))objc_msgSend)(display, @selector(displayId))),
      @"nativeSize": @[@(size.width), @(size.height)],
      @"pointScale": @(((unsigned long (*)(id, SEL))objc_msgSend)(display, @selector(pointScale))),
      @"currentOrientation": [orientation isKindOfClass:NSString.class] ? orientation : @"unknown",
      @"primary": @([display isEqual:mainDisplay]),
      @"backlightState": backlightState,
      @"type": @{@"integrated": @{}},
    }];
  }
  return printJSON(@{@"version": @1, @"integratedCount": @(integratedCount), @"displays": panels}) ? 0 : 1;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSString *mode = argc >= 2 ? @(argv[1]) : nil;
    if ([mode isEqualToString:@"set"] && argc == 3) return runSet(@(argv[2]));
    if ([mode isEqualToString:@"hinge"] && (argc == 2 || argc == 3)) {
      return readHinge(argc == 3 ? @(argv[2]) : nil);
    }
    if ([mode isEqualToString:@"panels"] && argc == 2) return readPanels();
    fprintf(stderr, "Usage: fold-helper set <pose|keyframes-json> | hinge [window-ms] | panels\n");
    return 2;
  }
}
