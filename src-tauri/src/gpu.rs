//! How busy the graphics processor is, read from Windows' performance counters (the same ones Task Manager shows).
//! Pixl's drawing happens in the web view's own processes, so its share counts this process and everything it
//! started. A background thread samples while the status bar is asking, and stops when it stops asking.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Latest reading: (Pixl's share, whole PC), percent of the busiest GPU engine, as Task Manager counts it.
struct State {
  latest: Option<(f64, f64)>,
  /// When the status bar last asked.
  asked: Option<Instant>,
  running: bool,
}

static STATE: Mutex<State> = Mutex::new(State { latest: None, asked: None, running: false });

const INTERVAL: Duration = Duration::from_millis(1500);
/// Stop sampling once the status bar hasn't asked for this long (Pixl minimised or hidden).
const IDLE: Duration = Duration::from_secs(6);

/// The latest reading, starting the sampler if it isn't running. None until there is one, or if the counters
/// aren't available.
pub fn usage() -> Option<(f64, f64)> {
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
  let q = counters::Query::open();
  let mut pids = counters::own_processes();
  let mut n = 0u32;
  loop {
    std::thread::sleep(INTERVAL);
    let reading = q.as_ref().and_then(|q| q.sample(&pids));
    let Ok(mut s) = STATE.lock() else { return };
    s.latest = reading;
    if q.is_none() || s.asked.is_none_or(|t| t.elapsed() > IDLE) {
      s.running = false;
      return;
    }
    drop(s);
    // The web view can start new processes (after a GPU reset, say): look again now and then.
    n += 1;
    if n % 10 == 0 { pids = counters::own_processes(); }
  }
}

#[cfg(windows)]
mod counters {
  use std::collections::{HashMap, HashSet};

  #[repr(C)]
  struct FmtValue { status: u32, value: f64 }
  #[repr(C)]
  struct FmtItem { name: *mut u16, value: FmtValue }
  #[repr(C)]
  struct ProcessEntry {
    size: u32, usage: u32, pid: u32, heap: usize, module: u32, threads: u32, parent: u32, priority: i32, flags: u32, exe: [u16; 260],
  }

  #[link(name = "pdh")]
  unsafe extern "system" {
    fn PdhOpenQueryW(source: *const u16, user: usize, query: *mut isize) -> u32;
    fn PdhAddEnglishCounterW(query: isize, path: *const u16, user: usize, counter: *mut isize) -> u32;
    fn PdhCollectQueryData(query: isize) -> u32;
    fn PdhGetFormattedCounterArrayW(counter: isize, format: u32, size: *mut u32, count: *mut u32, items: *mut FmtItem) -> u32;
    fn PdhCloseQuery(query: isize) -> u32;
  }
  #[link(name = "kernel32")]
  unsafe extern "system" {
    fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> isize;
    fn Process32FirstW(snap: isize, entry: *mut ProcessEntry) -> i32;
    fn Process32NextW(snap: isize, entry: *mut ProcessEntry) -> i32;
    fn CloseHandle(h: isize) -> i32;
  }
  const PDH_FMT_DOUBLE: u32 = 0x0000_0200;
  const PDH_FMT_NOCAP100: u32 = 0x0000_8000;
  const PDH_MORE_DATA: u32 = 0x8000_07D2;
  const TH32CS_SNAPPROCESS: u32 = 0x2;

  pub struct Query { q: isize, c: isize }
  // The handles are only used from the sampling thread that made them.
  unsafe impl Send for Query {}

  impl Query {
    pub fn open() -> Option<Query> {
      let mut q = 0isize;
      let mut c = 0isize;
      let path: Vec<u16> = "\\GPU Engine(*)\\Utilization Percentage\0".encode_utf16().collect();
      unsafe {
        if PdhOpenQueryW(std::ptr::null(), 0, &mut q) != 0 { return None; }
        if PdhAddEnglishCounterW(q, path.as_ptr(), 0, &mut c) != 0 { PdhCloseQuery(q); return None; }
        // A rate needs two samples: this is the first.
        PdhCollectQueryData(q);
      }
      Some(Query { q, c })
    }

    /// (Pixl's processes, whole PC): each engine type's use summed over its instances, then the busiest type.
    pub fn sample(&self, pids: &HashSet<u32>) -> Option<(f64, f64)> {
      unsafe {
        if PdhCollectQueryData(self.q) != 0 { return None; }
        let (mut size, mut count) = (0u32, 0u32);
        if PdhGetFormattedCounterArrayW(self.c, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, &mut size, &mut count, std::ptr::null_mut()) != PDH_MORE_DATA {
          return None;
        }
        // The buffer holds the items followed by their names; u64s keep it aligned for them.
        let mut buf = vec![0u64; (size as usize).div_ceil(8) + 1];
        let items = buf.as_mut_ptr() as *mut FmtItem;
        if PdhGetFormattedCounterArrayW(self.c, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, &mut size, &mut count, items) != 0 { return None; }
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
  }

  impl Drop for Query {
    fn drop(&mut self) { unsafe { PdhCloseQuery(self.q); } }
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
}

#[cfg(all(test, windows))]
mod tests {
  /// Reads the real counters twice (run with --nocapture to see the numbers).
  #[test]
  fn reads_gpu_counters() {
    let q = super::counters::Query::open().expect("GPU counters available");
    let pids = super::counters::own_processes();
    assert!(pids.contains(&std::process::id()));
    std::thread::sleep(std::time::Duration::from_millis(1200));
    let (mine, all) = q.sample(&pids).expect("a reading");
    println!("GPU: this process {mine:.1}%, whole PC {all:.1}%");
    assert!((0.0..=100.0).contains(&mine) && (0.0..=100.0).contains(&all));
    // What each reading costs (the sampler takes one every 1.5 s), and refreshing the process list.
    let mut worst = 0.0f64;
    let mut total = 0.0f64;
    for _ in 0..10 {
      std::thread::sleep(std::time::Duration::from_millis(200));
      let t = std::time::Instant::now();
      q.sample(&pids);
      let ms = t.elapsed().as_secs_f64() * 1000.0;
      total += ms;
      worst = worst.max(ms);
    }
    let t = std::time::Instant::now();
    super::counters::own_processes();
    println!("Reading: {:.2} ms average, {worst:.2} ms worst; process list: {:.2} ms", total / 10.0, t.elapsed().as_secs_f64() * 1000.0);
  }
}

#[cfg(not(windows))]
mod counters {
  use std::collections::HashSet;
  pub struct Query;
  impl Query {
    pub fn open() -> Option<Query> { None }
    pub fn sample(&self, _: &HashSet<u32>) -> Option<(f64, f64)> { None }
  }
  pub fn own_processes() -> HashSet<u32> { HashSet::new() }
}
