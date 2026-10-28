import { beginEnvelope, finishEnvelope, previewEnvelope } from '../actions';
import { defaultEnvelope, ENVELOPE_STYLES, type Envelope, type EnvelopeStyle } from '../core/envelope';
import { h } from './dom';
import { dialog, seg, select, slider } from './widgets';

/**
 * Layer › Warp…: bends the active layer with a preset (arc, flag, bulge, fisheye, twist...), previewed live. Text and
 * shapes stay editable and the warp follows their edits; image layers get an editable mesh warp.
 */
export async function warpDialog() {
  const s = await beginEnvelope();
  if (!s) return;
  const l = s.l;
  const had = l.type === 'raster' ? !!s.warp : !!s.envelope;
  // A layer fitted into a shape starts from a plain preset here (the fit has no settings to adjust).
  const e: Envelope = l.type !== 'raster' && s.envelope && s.envelope.style !== 'shape' ? { ...s.envelope } : defaultEnvelope();
  const show = () => previewEnvelope(s, e);
  show();
  const field = (label: string, el: HTMLElement) => h('div', { class: 'field wide' }, h('span', null, label), el);
  const range = (label: string, key: 'bend' | 'hDistort' | 'vDistort') =>
    slider({ label, min: -100, max: 100, value: e[key], unit: '%', onInput: (v) => { e[key] = Math.round(v); show(); } });
  dialog({
    title: 'Warp', width: 400, modeless: true,
    body: [
      field('Style', select(ENVELOPE_STYLES, e.style, (v: EnvelopeStyle) => { e.style = v; show(); })),
      field('Direction', seg([{ v: 'h', label: 'Horizontal' }, { v: 'v', label: 'Vertical' }], e.vertical ? 'v' : 'h', (v) => { e.vertical = v === 'v'; show(); })),
      range('Bend', 'bend'),
      range('Horizontal distortion', 'hDistort'),
      range('Vertical distortion', 'vDistort'),
      h('p', { class: 'dialog-note' }, l.type === 'raster'
        ? 'Image layers get a lossless mesh warp: fine-tune it with Move › Warp, or Apply it later.'
        : 'The text or shape stays editable, and the warp follows your edits.'),
    ],
    buttons: [
      ...(had ? [{ label: 'Remove warp', danger: true, onClick: () => { previewEnvelope(s, null); finishEnvelope(s, true); } }] : []),
      { label: 'Cancel', onClick: () => finishEnvelope(s, false) },
      { label: 'OK', primary: true, onClick: () => finishEnvelope(s, true) },
    ],
    onCancel: () => finishEnvelope(s, false),
  });
}
