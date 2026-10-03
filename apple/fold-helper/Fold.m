#import <Foundation/Foundation.h>
#import <mach/mach_time.h>
#import <math.h>

// Private simulator HID entry points; the host verifies the resulting hinge independently.
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

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSArray *frames = argc == 2 ? readFrames(@(argv[1])) : nil;
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
}
