#define main snapshotBridgeMain
#define sharedRuntime fixtureSharedRuntime
#import "SnapshotBridge.m"
#undef sharedRuntime
#undef main
#import <sys/wait.h>

static NSString *fixtureSocket;
static BOOL failInitialization;
static BOOL initialized;

BridgeRuntime *fixtureSharedRuntime(NSString **error) {
  if (access(fixtureSocket.fileSystemRepresentation, F_OK) == 0) exit(40);
  initialized = YES;
  if (failInitialization) { *error = @"fixture initialization failure"; return nil; }
  return (BridgeRuntime *)[NSObject new];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    fixtureSocket = [NSString stringWithUTF8String:argv[2]];
    failInitialization = strcmp(argv[1], "failure") == 0;
    pid_t client = -1;
    if (!failInitialization) {
      client = fork();
      if (client == 0) {
        for (int i = 0; i < 100; i++) {
          int fd = socket(AF_UNIX, SOCK_STREAM, 0);
          struct sockaddr_un address = {0}; address.sun_family = AF_UNIX;
          strlcpy(address.sun_path, fixtureSocket.fileSystemRepresentation, sizeof(address.sun_path));
          if (connect(fd, (struct sockaddr *)&address, sizeof(address)) == 0) {
            close(fd); _exit(0);
          }
          close(fd); usleep(10000);
        }
        _exit(41);
      }
    }
    int result = serve(fixtureSocket, 1, YES);
    if (!initialized) return 42;
    if (failInitialization) return result == 1 && access(fixtureSocket.fileSystemRepresentation, F_OK) != 0 ? 0 : 43;
    int status = 0; waitpid(client, &status, 0);
    return result == 0 && WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : 44;
  }
}
