/// <reference lib="webworker" />

/**
 * PNG encoding off the main thread. In the desktop app the page's own encoder does one image at a time however many
 * are asked for together; workers each encode on their own core, so saving several layers takes about half as long.
 */

type Job = { id: number; bitmap: ImageBitmap };

self.onmessage = async (e: MessageEvent<Job>) => {
  const { id, bitmap } = e.data;
  try {
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    c.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await c.convertToBlob({ type: 'image/png' });
    self.postMessage({ id, blob });
  } catch (err) {
    self.postMessage({ id, error: (err as Error)?.message ?? String(err) });
  }
};
