// An example plugin: a file format (PPM, the simplest image file there is) and a tool.

// ---------- PPM: "P6", width, height, max value, then RGB bytes (or "P3" with the numbers as text) ----------

pixl.onOpen('ppm', (bytes) => {
  // The header: four whitespace-separated words (comments start with #), then one whitespace byte before binary data.
  let i = 0;
  const word = () => {
    for (;;) {
      while (i < bytes.length && /\s/.test(String.fromCharCode(bytes[i]))) i++;
      if (bytes[i] !== 35) break; // '#': a comment to the line's end
      while (i < bytes.length && bytes[i] !== 10) i++;
    }
    let s = '';
    while (i < bytes.length && !/\s/.test(String.fromCharCode(bytes[i]))) s += String.fromCharCode(bytes[i++]);
    return s;
  };
  const kind = word(), width = +word(), height = +word(), max = +word();
  if ((kind !== 'P6' && kind !== 'P3') || !(width > 0 && height > 0 && max > 0)) throw new Error('not a PPM file');
  const image = new ImageData(width, height), d = image.data, k = 255 / max;
  if (kind === 'P6') {
    i++;
    const two = max > 255;
    for (let p = 0; p < width * height; p++) for (let c = 0; c < 3; c++) {
      const v = two ? (bytes[i++] << 8) | bytes[i++] : bytes[i++];
      d[p * 4 + c] = v * k;
    }
  } else {
    for (let p = 0; p < width * height; p++) for (let c = 0; c < 3; c++) d[p * 4 + c] = +word() * k;
  }
  for (let p = 0; p < width * height; p++) d[p * 4 + 3] = 255;
  return { width, height, layers: [{ name: 'Background', image }] };
});

pixl.onExport('ppm', (image) => {
  // PPM has no transparency: see-through areas go onto white.
  const head = new TextEncoder().encode(`P6\n${image.width} ${image.height}\n255\n`);
  const out = new Uint8Array(head.length + image.width * image.height * 3);
  out.set(head);
  const d = image.data;
  for (let p = 0, o = head.length; p < image.width * image.height; p++) {
    const a = d[p * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) out[o++] = Math.round(d[p * 4 + c] * a + 255 * (1 - a));
  }
  return out;
});

// ---------- Stamp: a round dot in the foreground colour where you click ----------

pixl.onTool('stamp', {
  async down(point) {
    const img = await pixl.image(), r = 12;
    const x = Math.round(point.x) - r, y = Math.round(point.y) - r;
    // (The layer's own pixels line up with the canvas when it hasn't been moved or scaled.)
    const px = await pixl.pixels(img.activeLayer, { x, y, width: r * 2, height: r * 2 });
    if (!px) return pixl.toast('Choose an image layer to stamp on.');
    const { fg } = await pixl.colors();
    const rgb = [1, 3, 5].map((s) => parseInt(fg.slice(s, s + 2), 16));
    for (let j = 0; j < px.height; j++) for (let i = 0; i < px.width; i++) {
      const dx = px.x + i + 0.5 - point.x, dy = px.y + j + 0.5 - point.y;
      const a = Math.max(0, Math.min(1, r - Math.hypot(dx, dy)));
      if (!a) continue;
      const o = (j * px.width + i) * 4;
      for (let c = 0; c < 3; c++) px.data[o + c] = px.data[o + c] * (1 - a) + rgb[c] * a;
      px.data[o + 3] = Math.max(px.data[o + 3], a * 255);
    }
    await pixl.setPixels(img.activeLayer, px, px.x, px.y, 'Stamp');
  },
});
