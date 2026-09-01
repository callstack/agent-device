import Darwin
import Foundation

struct SpikeProcessMetrics {
  let cpuMs: Double
  let memoryBytes: Int64?
}

func spikeProcessMetrics(since start: rusage) -> SpikeProcessMetrics {
  var current = rusage()
  getrusage(RUSAGE_SELF, &current)
  let startCpu = cpuMilliseconds(start)
  let currentCpu = cpuMilliseconds(current)
  return SpikeProcessMetrics(
    cpuMs: max(0, currentCpu - startCpu),
    memoryBytes: residentMemoryBytes()
  )
}

func currentResourceUsage() -> rusage {
  var usage = rusage()
  getrusage(RUSAGE_SELF, &usage)
  return usage
}

private func cpuMilliseconds(_ usage: rusage) -> Double {
  let user = Double(usage.ru_utime.tv_sec) * 1_000 + Double(usage.ru_utime.tv_usec) / 1_000
  let system = Double(usage.ru_stime.tv_sec) * 1_000 + Double(usage.ru_stime.tv_usec) / 1_000
  return user + system
}

private func residentMemoryBytes() -> Int64? {
  var info = mach_task_basic_info()
  var count = mach_msg_type_number_t(
    MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size
  )
  let status = withUnsafeMutablePointer(to: &info) { pointer in
    pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
      task_info(
        mach_task_self_,
        task_flavor_t(MACH_TASK_BASIC_INFO),
        rebound,
        &count
      )
    }
  }
  return status == KERN_SUCCESS ? Int64(info.resident_size) : nil
}
