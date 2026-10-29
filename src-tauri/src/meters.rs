//! The status bar's readouts: how busy the graphics processor and the processor are, and how much memory is in use,
//! for Pixl and for the whole PC. GPU and whole-PC processor use come from Windows' performance counters (the ones
//! Task Manager shows). Pixl's drawing happens in the web view's own processes, so "Pixl" counts this process and
//! everything it started. A background thread samples while the status bar is asking, and stops when it stops.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// One reading, each figure None if it couldn't be read: GPU (Pixl, PC) and CPU (Pixl, PC) in percent, memory Pixl
/// is using in MB and the PC's memory in use in percent.
pub type Reading = [Option<f64>; 6];

struct State {
  latest: Option<Reading>,
  /// When the status bar last asked.
  asked: Option<Instant>,
  running: bool,
}

static STATE: Mutex<State> = Mutex::new(State { latest: None, asked: None, running: false });

const INTERVAL: Duration = Duration::from_millis(1500);
/// Stop sampling once the status bar hasn't asked for this long (Pixl minimised or hidden, or the readouts off).
const IDLE: Duration = Duration::from_secs(6);

/// The latest reading, starting the sampler if it isn't running. None until there is one.
pub fn read() -> Option<Reading> {
  let mut s = STATE.lock().ok()?;
  s.asked = Some(Instant::now());
  if !s.running {
    s.running = true;
    s.latest = None;
    std::thread::spawn(sample_loop);
  }
  s.latest
}

fn sample_loop() {
  let mut sampler = sys::Sampler::new();
  let mut n = 0u32;
  loop {
    std::thread::sleep(INTERVAL);
    // The web view can start new processes (after a GPU reset, say): look again now and then.
    if n % 10 == 0 { sampler.refresh_processes(); }
    n += 1;
    let reading = sampler.sample();
    let Ok(mut s) = STATE.lock() else { return };
    s.latest = Some(reading);
    if s.asked.is_none_or(|t| t.elapsed() > IDLE) {
      s.running = false;
      return;
    }
  }
}

#[cfg(windows)]
mod sys {
  use std::collections::{HashMap, HashSet};
  use std::time::Instant;

  #[repr(C)]
  struct FmtValue { status: u32, value: f64 }
  #[repr(C)]
  struct FmtItem { name: *mut u16, value: FmtValue }
  #[repr(C)]
  struct ProcessEntry {
    size: u32, usage: u32, pid: u32, heap: usize, module: u32, threads: u32, parent: u32, priority: i32, flags: u32, exe: [u16; 260],
  }
  #[repr(C)]
  #[derive(Default, Clone, Copy)]
  struct FileTime { low: u32, high: u32 }
  #[repr(C)]
  #[derive(Default)]
  struct MemCounters {
    cb: u32, faults: u32, peak_ws: usize, ws: usize, peak_paged: usize, paged: usize, peak_nonpaged: usize, nonpaged: usize,
    pagefile: usize, peak_pagefile: usize, private: usize,
  }
  #[repr(C)]
  #[derive(Default)]
  struct MemStatus { len: u32, load: u32, total: u64, avail: u64, total_page: u64, avail_page: u64, total_virt: u64, avail_virt: u64, avail_ext: u64 }

  #[link(name = "pdh")]
  unsafe extern "system" {
    fn PdhOpenQueryW(source: *const u16, user: usize, query: *mut isize) -> u32;
    fn PdhAddEnglishCounterW(query: isize, path: *const u16, user: usize, counter: *mut isize) -> u32;
    fn PdhCollectQueryData(query: isize) -> u32;
    fn PdhGetFormattedCounterArrayW(counter: isize, format: u32, size: *mut u32, count: *mut u32, items: *mut FmtItem) -> u32;
    fn PdhGetFormattedCounterValue(counter: isize, format: u32, kind: *mut u32, value: *mut FmtValue) -> u32;
    fn PdhCloseQuery(query: isize) -> u32;
  }
  #[link(name = "kernel32")]
  unsafe extern "system" {
    fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> isize;
    fn Process32FirstW(snap: isize, entry: *mut ProcessEntry) -> i32;
    fn Process32NextW(snap: isize, entry: *mut ProcessEntry) -> i32;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
    fn GetProcessTimes(h: isize, created: *mut FileTime, exited: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
    fn K32GetProcessMemoryInfo(h: isize, counters: *mut MemCounters, cb: u32) -> i32;
    fn GlobalMemoryStatusEx(status: *mut MemStatus) -> i32;
    fn CloseHandle(h: isize) -> i32;
  }
  const PDH_FMT_DOUBLE: u32 = 0x0000_0200;
  const PDH_FMT_NOCAP100: u32 = 0x0000_8000;
  const PDH_MORE_DATA: u32 = 0x8000_07D2;
  const TH32CS_SNAPPROCESS: u32 = 0x2;
  const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

  fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain([0]).collect() }

  pub struct Sampler {
    /// The counter query (GPU engines, and the whole PC's processor), if Windows has them.
    q: isize,
    gpu: Option<isize>,
    cpu: Option<isize>,
    pids: HashSet<u32>,
    /// Processor time Pixl's processes had used at the last reading (100 ns units), and when.
    cpu_was: Option<(u64, Instant)>,
  }
  // The handles are only used from the sampling thread that made them.
  unsafe impl Send for Sampler {}

  impl Sampler {
    pub fn new() -> Sampler {
      let mut q = 0isize;
      let (mut gpu, mut cpu) = (None, None);
      unsafe {
        if PdhOpenQueryW(std::ptr::null(), 0, &mut q) == 0 {
          let add = |path: &str| { let mut c = 0isize; (PdhAddEnglishCounterW(q, wide(path).as_ptr(), 0, &mut c) == 0).then_some(c) };
          gpu = add("\\GPU Engine(*)\\Utilization Percentage");
          // Task Manager's processor figure; the older counter where that one isn't available.
          cpu = add("\\Processor Information(_Total)\\% Processor Utility").or_else(|| add("\\Processor(_Total)\\% Processor Time"));
          // Rates need two samples: this is the first.
          PdhCollectQueryData(q);
        } else {
          q = 0;
        }
      }
      Sampler { q, gpu, cpu, pids: HashSet::new(), cpu_was: None }
    }

    pub fn refresh_processes(&mut self) {
      self.pids = own_processes();
    }

    pub fn sample(&mut self) -> super::Reading {
      let mut r: super::Reading = [None; 6];
      unsafe {
        if self.q != 0 && PdhCollectQueryData(self.q) == 0 {
          if let Some(c) = self.gpu && let Some((mine, all)) = gpu_use(c, &self.pids) { r[0] = Some(mine); r[1] = Some(all); }
          if let Some(c) = self.cpu {
            let mut kind = 0u32;
            let mut v = FmtValue { status: 0, value: 0.0 };
            if PdhGetFormattedCounterValue(c, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, &mut kind, &mut v) == 0 && v.status == 0 {
              r[3] = Some(v.value.clamp(0.0, 100.0));
            }
          }
        }
        // Pixl's processor use: the time its processes ran since the last reading, over the time that passed on
        // every core. And its memory: what its processes have set aside for themselves.
        let mut busy = 0u64;
        let mut private = 0u64;
        for &pid in &self.pids {
          let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
          if h == 0 { continue; }
          let (mut c, mut e, mut k, mut u) = (FileTime::default(), FileTime::default(), FileTime::default(), FileTime::default());
          if GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u) != 0 {
            busy += ((k.high as u64) << 32 | k.low as u64) + ((u.high as u64) << 32 | u.low as u64);
          }
          let mut m = MemCounters { cb: std::mem::size_of::<MemCounters>() as u32, ..Default::default() };
          if K32GetProcessMemoryInfo(h, &mut m, m.cb) != 0 { private += m.private as u64; }
          CloseHandle(h);
        }
        let now = Instant::now();
        if let Some((was, at)) = self.cpu_was {
          let cores = std::thread::available_parallelism().map_or(1, |n| n.get()) as f64;
          let wall = now.duration_since(at).as_secs_f64() * 1e7 * cores;
          // (A process that ended in between makes the total drop; skip that reading.)
          if busy >= was && wall > 0.0 { r[2] = Some(((busy - was) as f64 / wall * 100.0).clamp(0.0, 100.0)); }
        }
        self.cpu_was = Some((busy, now));
        if !self.pids.is_empty() { r[4] = Some(private as f64 / 1_048_576.0); }
        let mut ms = MemStatus { len: std::mem::size_of::<MemStatus>() as u32, ..Default::default() };
        if GlobalMemoryStatusEx(&mut ms) != 0 && ms.total > 0 {
          r[5] = Some((ms.total - ms.avail) as f64 / ms.total as f64 * 100.0);
        }
      }
      r
    }
  }

  impl Drop for Sampler {
    fn drop(&mut self) { if self.q != 0 { unsafe { PdhCloseQuery(self.q); } } }
  }

  /// GPU use (Pixl's processes, whole PC): each engine type's use summed over its instances, then the busiest type,
  /// as Task Manager counts it.
  unsafe fn gpu_use(c: isize, pids: &HashSet<u32>) -> Option<(f64, f64)> {
    unsafe {
      let (mut size, mut count) = (0u32, 0u32);
      if PdhGetFormattedCounterArrayW(c, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, &mut size, &mut count, std::ptr::null_mut()) != PDH_MORE_DATA {
        return None;
      }
      // The buffer holds the items followed by their names; u64s keep it aligned for them.
      let mut buf = vec![0u64; (size as usize).div_ceil(8) + 1];
      let items = buf.as_mut_ptr() as *mut FmtItem;
      if PdhGetFormattedCounterArrayW(c, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, &mut size, &mut count, items) != 0 { return None; }
      let mut mine: HashMap<String, f64> = HashMap::new();
      let mut all: HashMap<String, f64> = HashMap::new();
      for i in 0..count as usize {
        let it = &*items.add(i);
        if it.value.status != 0 || it.name.is_null() { continue; }
        let mut len = 0;
        while *it.name.add(len) != 0 { len += 1; }
        let name = String::from_utf16_lossy(std::slice::from_raw_parts(it.name, len));
        // "pid_1234_luid_0x00000000_0x0000D1A3_phys_0_eng_0_engtype_3D"
        let Some(eng) = name.split("_engtype_").nth(1) else { continue };
        let pid = name.strip_prefix("pid_").and_then(|r| r.split('_').next()).and_then(|p| p.parse::<u32>().ok());
        *all.entry(eng.to_string()).or_default() += it.value.value;
        if pid.is_some_and(|p| pids.contains(&p)) { *mine.entry(eng.to_string()).or_default() += it.value.value; }
      }
      let top = |m: &HashMap<String, f64>| m.values().fold(0.0f64, |a, &b| a.max(b)).min(100.0);
      Some((top(&mine), top(&all)))
    }
  }

  /// This process and every process it started (the web view's browser, GPU and renderer processes).
  pub fn own_processes() -> HashSet<u32> {
    let me = std::process::id();
    let mut parent: Vec<(u32, u32)> = Vec::new();
    unsafe {
      let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
      if snap != -1 {
        let mut e: ProcessEntry = std::mem::zeroed();
        e.size = std::mem::size_of::<ProcessEntry>() as u32;
        let mut ok = Process32FirstW(snap, &mut e);
        while ok != 0 {
          parent.push((e.pid, e.parent));
          ok = Process32NextW(snap, &mut e);
        }
        CloseHandle(snap);
      }
    }
    let mut set: HashSet<u32> = HashSet::from([me]);
    loop {
      let before = set.len();
      for &(p, pp) in &parent { if p != pp && set.contains(&pp) { set.insert(p); } }
      if set.len() == before { break; }
    }
    set
  }

  #[cfg(test)]
  mod tests {
    /// Reads the real counters (run with --nocapture to see the numbers and what each reading costs).
    #[test]
    fn reads_meters() {
      let mut s = super::Sampler::new();
      s.refresh_processes();
      assert!(s.pids.contains(&std::process::id()));
      s.sample();
      std::thread::sleep(std::time::Duration::from_millis(1200));
      let r = s.sample();
      println!("GPU {:?} / {:?} %, CPU {:?} / {:?} %, memory {:?} MB / {:?} %", r[0], r[1], r[2], r[3], r[4], r[5]);
      assert!(r.iter().all(|v| v.is_some()), "every figure read");
      let mut worst = 0.0f64;
      let mut total = 0.0f64;
      for _ in 0..10 {
        std::thread::sleep(std::time::Duration::from_millis(200));
        let t = std::time::Instant::now();
        s.sample();
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        total += ms;
        worst = worst.max(ms);
      }
      let t = std::time::Instant::now();
      s.refresh_processes();
      println!("Reading: {:.2} ms average, {worst:.2} ms worst; process list: {:.2} ms", total / 10.0, t.elapsed().as_secs_f64() * 1000.0);
    }
  }
}

#[cfg(not(windows))]
mod sys {
  pub struct Sampler;
  impl Sampler {
    pub fn new() -> Sampler { Sampler }
    pub fn refresh_processes(&mut self) {}
    pub fn sample(&mut self) -> super::Reading { [None; 6] }
  }
}
