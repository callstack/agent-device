#import <Foundation/Foundation.h>
#import <mach/mach_time.h>

// Private simulator HID entry points; the host verifies the resulting hinge independently.
extern CFDataRef IOCFSerialize(CFTypeRef object, CFOptionFlags options);
extern CFTypeRef IOHIDEventCreateVendorDefinedEvent(CFAllocatorRef allocator, uint64_t timestamp,
    uint32_t usagePage, uint32_t usage, uint32_t version, const uint8_t *data,
    CFIndex length, uint32_t options);
extern CFTypeRef IOHIDEventSystemClientCreate(CFAllocatorRef allocator);
extern void IOHIDEventSystemClientDispatchEvent(CFTypeRef client, CFTypeRef event);

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2) return 2;
    NSDictionary *angles = @{@"closed": @0, @"half-open": @130, @"open": @180};
    NSNumber *angle = angles[@(argv[1])];
    if (!angle) {
      fprintf(stderr, "Expected closed, half-open, or open\n");
      return 2;
    }
    NSDictionary *payload = @{
      @"provider": @"com.apple.Virtualization.VirtualMachines",
      @"source": @"hinge-slider-control",
      @"type": @"range",
      @"value": angle,
    };
    CFDataRef data = IOCFSerialize((__bridge CFTypeRef)payload, 1);
    if (!data) {
      fprintf(stderr, "Unable to serialize simulator hinge payload\n");
      return 1;
    }
    CFTypeRef client = IOHIDEventSystemClientCreate(kCFAllocatorDefault);
    CFTypeRef event = IOHIDEventCreateVendorDefinedEvent(kCFAllocatorDefault,
        mach_absolute_time(), 0xff61, 0x5b, 0, CFDataGetBytePtr(data), CFDataGetLength(data), 0);
    if (client && event) IOHIDEventSystemClientDispatchEvent(client, event);
    BOOL dispatched = client && event;
    if (event) CFRelease(event);
    if (client) CFRelease(client);
    CFRelease(data);
    if (!dispatched) fprintf(stderr, "Unable to create simulator HID client or event\n");
    return dispatched ? 0 : 1;
  }
}
