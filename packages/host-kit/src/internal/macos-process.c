#include <errno.h>
#include <libproc.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <unistd.h>

#define MAX_ARGS_BYTES (32 * 1024)
#define MAX_KERNEL_BYTES (1024 * 1024)

static bool identity(int pid, struct proc_bsdinfo *info) {
  /* XNU proc_pidinfo requires arg=1 for PROC_PIDTBSDINFO to include zombies. */
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 1, info, sizeof(*info)) == sizeof(*info)
    && info->pbi_pid == (unsigned int)pid && info->pbi_uid == getuid()
    && info->pbi_ruid == getuid() && info->pbi_start_tvsec > 0
    && info->pbi_start_tvusec < 1000000;
}

static bool same_identity(const struct proc_bsdinfo *a, const struct proc_bsdinfo *b) {
  return a->pbi_pid == b->pbi_pid && a->pbi_uid == b->pbi_uid && a->pbi_ruid == b->pbi_ruid
    && a->pbi_start_tvsec == b->pbi_start_tvsec && a->pbi_start_tvusec == b->pbi_start_tvusec
    && (a->pbi_status == SZOMB) == (b->pbi_status == SZOMB);
}

static bool args_bounds(char *buffer, size_t length, char **start, char **finish, int *argc) {
  if (length <= sizeof(int)) return false;
  memcpy(argc, buffer, sizeof(int));
  if (*argc <= 0 || *argc > MAX_ARGS_BYTES) return false;
  char *cursor = buffer + sizeof(int), *end = buffer + length;
  size_t size = strnlen(cursor, (size_t)(end - cursor));
  if (size == 0 || size == (size_t)(end - cursor)) return false;
  cursor += size;
  while (cursor < end && *cursor == 0) cursor++;
  *start = cursor;
  for (int i = 0; i < *argc; i++) {
    if (cursor >= end) return false;
    size = strnlen(cursor, (size_t)(end - cursor));
    if (size == (size_t)(end - cursor)) return false;
    cursor += size + 1;
    if (cursor - *start > MAX_ARGS_BYTES) return false;
  }
  *finish = cursor;
  return true;
}

static int observe(int pid) {
  struct proc_bsdinfo before = {0}, after = {0};
  if (!identity(pid, &before)) return 1;
  char *buffer = NULL, *start = NULL, *finish = NULL;
  int argc = 0;
  if (before.pbi_status != SZOMB) {
    buffer = malloc(MAX_KERNEL_BYTES);
    size_t length = MAX_KERNEL_BYTES;
    int mib[] = {CTL_KERN, KERN_PROCARGS2, pid};
    if (!buffer || sysctl(mib, 3, buffer, &length, NULL, 0) != 0
        || !args_bounds(buffer, length, &start, &finish, &argc)) {
      free(buffer);
      return 1;
    }
  }
  if (!identity(pid, &after) || !same_identity(&before, &after)) {
    free(buffer);
    return 1;
  }
  printf("{\"pid\":%d,\"ppid\":%u,\"startSeconds\":\"%llu\",\"startMicros\":%llu,\"zombie\":%s,\"argc\":%d,\"argvHex\":\"",
    pid, after.pbi_ppid, after.pbi_start_tvsec, after.pbi_start_tvusec,
    after.pbi_status == SZOMB ? "true" : "false", argc);
  for (char *cursor = start; cursor && cursor < finish; cursor++) printf("%02x", (unsigned char)*cursor);
  puts("\"}");
  free(buffer);
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--all") == 0) {
    int count = proc_listallpids(NULL, 0);
    if (count <= 0 || count > 16384) return 1;
    size_t bytes = (size_t)(count + 128) * sizeof(int);
    int *pids = calloc(1, bytes);
    if (!pids) return 1;
    count = proc_listallpids(pids, (int)bytes);
    if (count < 0 || count > (int)(bytes / sizeof(int))) { free(pids); return 1; }
    for (int i = 0; i < count; i++) if (pids[i] > 0) observe(pids[i]);
    free(pids);
    return 0;
  }
  if (argc < 2 || argc > 1025) return 2;
  int successes = 0;
  for (int i = 1; i < argc; i++) {
    if (argv[i][0] < '1' || argv[i][0] > '9') return 2;
    char *end = NULL;
    errno = 0;
    long pid = strtol(argv[i], &end, 10);
    if (errno || *end || pid <= 0 || pid > INT_MAX) return 2;
    if (observe((int)pid) == 0) successes++;
  }
  return successes ? 0 : 1;
}
