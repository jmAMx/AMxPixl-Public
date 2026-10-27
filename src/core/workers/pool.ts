/**
 * A small pool of background workers (Web Workers) so heavy CPU jobs use the other cores and the window stays
 * responsive. Jobs go to whichever worker is free; each resolves with that worker's reply.
 */
export class WorkerPool<J extends object, R> {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: { job: J; transfer: Transferable[]; res: (r: R) => void; rej: (e: Error) => void }[] = [];
  private pending = new Map<number, { res: (r: R) => void; rej: (e: Error) => void; w: Worker }>();
  private nextId = 1;

  constructor(private make: () => Worker, private size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))) {}

  private spawn() {
    const w = this.make();
    w.onmessage = (e: MessageEvent<R & { id: number; error?: string }>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      this.idle.push(w);
      if (e.data.error) p.rej(new Error(e.data.error)); else p.res(e.data);
      this.pump();
    };
    w.onerror = (e) => {
      // A crashed worker fails its job and is replaced.
      for (const [id, p] of this.pending) if (p.w === w) { this.pending.delete(id); p.rej(new Error(e.message || 'Background task failed')); }
      this.workers = this.workers.filter((x) => x !== w);
      w.terminate();
      this.pump();
    };
    this.workers.push(w);
    this.idle.push(w);
  }

  private pump() {
    while (this.queue.length) {
      if (!this.idle.length && this.workers.length < this.size) this.spawn();
      const w = this.idle.pop();
      if (!w) return;
      const q = this.queue.shift()!;
      const id = this.nextId++;
      this.pending.set(id, { res: q.res, rej: q.rej, w });
      w.postMessage({ ...q.job, id }, q.transfer);
    }
  }

  run(job: J, transfer: Transferable[] = []): Promise<R> {
    return new Promise((res, rej) => { this.queue.push({ job, transfer, res, rej }); this.pump(); });
  }

  /** Frees the workers (they're started again on the next job). */
  close() { for (const w of this.workers) w.terminate(); this.workers = []; this.idle = []; }
}
