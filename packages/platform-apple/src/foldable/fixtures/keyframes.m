#define main fold_helper_main
#import "Fold.m"
#undef main
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2) return 2;
    NSArray *cases = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:@(argv[1])] options:0 error:NULL];
    if (!cases) return 2;
    for (NSDictionary *entry in cases) {
      NSArray *frames = readFrames(entry[@"keyframesJson"]);
      BOOL valid = frames != nil;
      if (valid) {
        for (NSDictionary *sample in entry[@"samples"]) {
          if (fabs(angleAtTime(frames, [sample[@"atMs"] doubleValue]) - [sample[@"angle"] doubleValue]) > 1e-6) { fprintf(stderr, "%s at %sms\n", [entry[@"name"] UTF8String], [[sample[@"atMs"] description] UTF8String]); return 1; }
        }
      }
      if (valid != [entry[@"valid"] boolValue]) { fprintf(stderr, "%s\n", [entry[@"name"] UTF8String]); return 1; }
    }
    return 0;
  }
}
