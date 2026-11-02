/*
 * The process-table scan behind the reader's system surface host check. It runs in the reader's own
 * process, so the check spawns nothing.
 */

#import "SnapshotBridgeSurfaceHosts.h"

#import <errno.h>
#import <stdlib.h>
#import <string.h>
#import <sys/sysctl.h>

typedef NS_ENUM(NSInteger, SurfaceHostScan) {
  SurfaceHostAbsent,
  SurfaceHostPresent,
  SurfaceHostUnverified,
};

static const char kSimulatorUdidPrefix[] = "SIMULATOR_UDID=";

/*
 * Whether a process has exited: gone from the process table, or a zombie waiting to be reaped. The
 * kernel keeps no arguments for either, and neither presents anything, so a host that exited
 * between the table read and its argument read is absent, not unplaceable.
 */
static BOOL processExited(pid_t pid)
{
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
  struct kinfo_proc process;
  size_t size = sizeof(process);
  if (sysctl(mib, 4, &process, &size, NULL, 0) != 0) return errno == ESRCH;
  return size == 0 || process.kp_proc.p_stat == SZOMB;
}

/*
 * Whether one process runs this host's binary for this Simulator. KERN_PROCARGS2 holds argc, the
 * executable path, then argv and envp as NUL-terminated strings. Simulator processes carry
 * SIMULATOR_UDID, so only a scope naming another device is a negative. A live process whose
 * arguments cannot be read, or whose environment carries no scope, proves nothing.
 */
static SurfaceHostScan scanProcess(pid_t pid, const char *executable, const char *udidAssignment)
{
  int argumentMaximum = 0;
  size_t size = sizeof(argumentMaximum);
  int argumentMaximumMib[2] = {CTL_KERN, KERN_ARGMAX};
  if (sysctl(argumentMaximumMib, 2, &argumentMaximum, &size, NULL, 0) != 0 || argumentMaximum <= 0) {
    return SurfaceHostUnverified;
  }
  char *buffer = malloc((size_t)argumentMaximum);
  if (!buffer) return SurfaceHostUnverified;
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
  size = (size_t)argumentMaximum;
  if (sysctl(mib, 3, buffer, &size, NULL, 0) != 0 || size <= sizeof(int)) {
    free(buffer);
    return processExited(pid) ? SurfaceHostAbsent : SurfaceHostUnverified;
  }
  int argc = 0;
  memcpy(&argc, buffer, sizeof(argc));
  if (argc < 0) {
    free(buffer);
    return SurfaceHostUnverified;
  }
  const char *cursor = buffer + sizeof(int);
  const char *end = buffer + size;
  size_t pathLength = strnlen(cursor, (size_t)(end - cursor));
  if (cursor + pathLength >= end) {
    free(buffer);
    return SurfaceHostUnverified;
  }
  // The fragment must end the executable path at a path component, so a sibling such as
  // `Name.app/NameHelper` or `OtherName.app/Name` is not the host.
  size_t fragmentLength = strlen(executable);
  const char *suffix = pathLength >= fragmentLength ? cursor + pathLength - fragmentLength : NULL;
  if (!suffix || strcmp(suffix, executable) != 0 || (suffix > cursor && suffix[-1] != '/')) {
    free(buffer);
    return SurfaceHostAbsent;
  }
  cursor += pathLength;
  while (cursor < end && *cursor == '\0') cursor += 1;
  for (int skipped = 0; skipped < argc && cursor < end; skipped += 1) {
    cursor += strnlen(cursor, (size_t)(end - cursor)) + 1;
  }
  if (cursor > end) cursor = end;
  // The kernel may pad argv before the environment.
  while (cursor < end && *cursor == '\0') cursor += 1;
  // A matching scope anywhere in the environment places the process here. Another scope proves
  // absence only when the walk reached the environment's end, so an entry order or a truncated
  // block cannot hide this Simulator's scope.
  BOOL sawOtherScope = NO;
  BOOL walkedToEnd = NO;
  while (cursor < end) {
    if (*cursor == '\0') {
      walkedToEnd = YES;
      break;
    }
    size_t length = strnlen(cursor, (size_t)(end - cursor));
    if (cursor + length >= end) break;
    if (strncmp(cursor, kSimulatorUdidPrefix, sizeof(kSimulatorUdidPrefix) - 1) == 0) {
      if (strcmp(cursor, udidAssignment) == 0) {
        free(buffer);
        return SurfaceHostPresent;
      }
      sawOtherScope = YES;
    }
    cursor += length + 1;
  }
  // The last entry's terminator can be the block's last byte.
  if (cursor == end) walkedToEnd = YES;
  free(buffer);
  return sawOtherScope && walkedToEnd ? SurfaceHostAbsent : SurfaceHostUnverified;
}

/*
 * The first registered host running for this Simulator, or nil. The kernel keeps the executable's
 * basename cut to MAXCOMLEN as the process name, so the name selects the few candidates whose
 * arguments are read. `unverified` reports a candidate the scan could not place.
 */
NSString *_Nullable runningSurfaceHost(NSArray<NSString *> *executables,
                                       NSString *simulatorUdid,
                                       BOOL *unverified)
{
  *unverified = NO;
  int mib[3] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL};
  struct kinfo_proc *processes = NULL;
  size_t length = 0;
  for (int attempt = 0; attempt < 3 && !processes; attempt += 1) {
    if (sysctl(mib, 3, NULL, &length, NULL, 0) != 0) break;
    // Room for processes that start between the size read and the copy.
    length += 32 * sizeof(struct kinfo_proc);
    processes = malloc(length);
    if (!processes) break;
    if (sysctl(mib, 3, processes, &length, NULL, 0) == 0) break;
    const int error = errno;
    free(processes);
    processes = NULL;
    if (error != ENOMEM) break;
  }
  if (!processes) {
    *unverified = YES;
    return nil;
  }
  NSString *udidAssignment = [NSString stringWithFormat:@"%s%@", kSimulatorUdidPrefix, simulatorUdid];
  NSString *running = nil;
  size_t count = length / sizeof(struct kinfo_proc);
  for (NSString *executable in executables) {
    const char *processName = executable.lastPathComponent.UTF8String;
    for (size_t index = 0; index < count && !running; index += 1) {
      if (strncmp(processes[index].kp_proc.p_comm, processName, MAXCOMLEN) != 0) continue;
      SurfaceHostScan scan = scanProcess(processes[index].kp_proc.p_pid, executable.UTF8String,
                                         udidAssignment.UTF8String);
      if (scan == SurfaceHostPresent) running = executable;
      if (scan == SurfaceHostUnverified) *unverified = YES;
    }
    if (running) break;
  }
  free(processes);
  return running;
}
