// Prints the reader's surface host scan verdict for one executable on one Simulator.
#import "SnapshotBridgeSurfaceHosts.h"

#include <stdio.h>

int main(int argc, const char *argv[])
{
  @autoreleasepool {
    if (argc != 3) return 2;
    BOOL unverified = NO;
    NSString *running = runningSurfaceHost(@[ @(argv[1]) ], @(argv[2]), &unverified);
    printf("%s\n", running ? "present" : unverified ? "unverified" : "absent");
  }
  return 0;
}
