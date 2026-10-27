/// <reference lib="webworker" />
import { parseXcf, xcfBuffers } from '../import/xcf';

/** Reads a GIMP file in the background (decompression and GIMP filters are the slow parts). */
self.onmessage = async (e: MessageEvent<{ id: number; buf: ArrayBuffer }>) => {
  try {
    const result = await parseXcf(e.data.buf);
    (self as DedicatedWorkerGlobalScope).postMessage({ id: e.data.id, result }, xcfBuffers(result));
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({ id: e.data.id, error: (err as Error).message });
  }
};
