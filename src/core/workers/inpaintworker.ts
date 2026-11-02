/// <reference lib="webworker" />
import { inpaint, type InpaintJob } from '../inpaint';

/** Content-aware fill off the main thread (it can take a few seconds on a big hole), so the window stays responsive. */
self.onmessage = (e: MessageEvent<InpaintJob & { id: number }>) => {
  const { id, ...job } = e.data;
  try {
    const rgba = inpaint(job);
    self.postMessage({ id, rgba }, [rgba.buffer]);
  } catch (err) {
    self.postMessage({ id, error: (err as Error)?.message ?? String(err) });
  }
};
