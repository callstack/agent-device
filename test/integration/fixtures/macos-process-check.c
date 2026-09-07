#define main process_helper_main
#include "../../../packages/host-kit/src/internal/macos-process.c"
#undef main
#include <assert.h>
#include <sys/wait.h>

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "zombie") == 0) {
    pid_t child = fork();
    if (child == 0) _exit(0);
    assert(child > 0);
    printf("%d\n", child);
    fflush(stdout);
    getchar();
    waitpid(child, NULL, 0);
    return 0;
  }
  struct proc_bsdinfo a = {0}, b = {0};
  a.pbi_pid = b.pbi_pid = 123;
  a.pbi_start_tvsec = b.pbi_start_tvsec = 1234;
  assert(same_identity(&a, &b));
  b.pbi_start_tvusec++;
  assert(!same_identity(&a, &b));
  b = a; b.pbi_start_tvsec++;
  assert(!same_identity(&a, &b));
  b = a; b.pbi_uid++;
  assert(!same_identity(&a, &b));
  b = a; b.pbi_ruid++;
  assert(!same_identity(&a, &b));
  b = a; b.pbi_pid++;
  assert(!same_identity(&a, &b));
  b = a; b.pbi_status = SZOMB;
  assert(!same_identity(&a, &b));

  char buffer[256] = {0}, *start = NULL, *finish = NULL;
  int count = 3, parsed = 0;
  memcpy(buffer, &count, sizeof(count));
  const char sample[] = "/bin/node\0\0node\0\0arg\0SECRET=not-an-argument\0";
  memcpy(buffer + sizeof(count), sample, sizeof(sample));
  size_t length = sizeof(count) + sizeof(sample);
  assert(args_bounds(buffer, length, &start, &finish, &parsed));
  assert(parsed == 3 && finish - start == 10);
  assert(memcmp(start, "node\0\0arg\0", 10) == 0);
  assert(!args_bounds(buffer, sizeof(count), &start, &finish, &parsed));
  assert(!args_bounds(buffer, (size_t)(finish - buffer) - 1, &start, &finish, &parsed));
  count = INT_MAX;
  memcpy(buffer, &count, sizeof(count));
  assert(!args_bounds(buffer, length, &start, &finish, &parsed));
  puts("identity and argument bounds passed");
  return 0;
}
