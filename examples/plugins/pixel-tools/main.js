// An example script plugin. It runs in a sandboxed page: everything it does goes through `pixl` (see README.md),
// and only what plugin.json's "permissions" allow.

/** Inverts the selected layer's colours, only inside the selection if there is one (soft edges blend). */
async function invert() {
  const img = await pixl.image();
  const px = await pixl.pixels(img.activeLayer);
  if (!px) return pixl.toast('Select an image layer first.');
  const sel = await pixl.selection();
  const d = px.data;
  for (let i = 0; i < d.length; i += 4) {
    // (The layer's pixels and the selection line up when the layer hasn't been moved or scaled.)
    const k = sel ? sel.data[i + 3] / 255 : 1;
    for (let c = 0; c < 3; c++) d[i + c] = d[i + c] + (255 - 2 * d[i + c]) * k;
  }
  await pixl.setPixels(img.activeLayer, px, px.x, px.y, 'Invert');
}

/** Adds a layer of grey noise the image's size. */
async function noiseLayer() {
  const { width, height } = await pixl.image();
  const noise = new ImageData(width, height);
  for (let i = 0; i < noise.data.length; i += 4) {
    const v = Math.random() * 255;
    noise.data[i] = noise.data[i + 1] = noise.data[i + 2] = v;
    noise.data[i + 3] = 255;
  }
  await pixl.addLayer('Noise', noise);
}

pixl.onCommand('invert', invert);
pixl.onCommand('noise-layer', noiseLayer);

// The panel: what's open, and buttons for the commands and one of Pixl's own (a blur, run as a command).
document.body.innerHTML = `
  <p id="info">…</p>
  <p><button id="inv">Invert</button> <button id="noise">Noise layer</button></p>
  <p><button id="blur">Gaussian blur 4 px</button></p>`;
const info = document.getElementById('info');
const show = async () => {
  try { const i = await pixl.image(); info.textContent = `${i.name}: ${i.width} × ${i.height} px, ${i.layers.length} layers`; }
  catch { info.textContent = 'No image open.'; }
};
const go = (f) => async () => { try { await f(); } catch (e) { pixl.toast(e.message); } show(); };
document.getElementById('inv').onclick = go(invert);
document.getElementById('noise').onclick = go(noiseLayer);
document.getElementById('blur').onclick = go(() => pixl.run('filter', { kind: 'gblur', settings: { radius: 4 } }));
show();
