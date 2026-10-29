import { app } from '../app';
import { visiblePlaced } from '../core/document';
import { layerBox } from '../core/bounds';
import { layerMatrix, localBounds, ctx2d } from '../core/layers';
import { apply, corners, decompose, identity, invert, mapRect, mul, pointInPoly, scale, translate, union, xformMatrix, type Mat, type Pt, type Rect, type Xform } from '../core/math';
import type { PlacedLayer, RasterLayer, ShapeProps } from '../core/types';
import { warpHandles, warpPoint } from '../core/warp';
import { alignLayers, applyWarp, distributeLayers, ensureWarp, flipLayer, removeWarp, resetTransform, rotateLayer90, setModel, setPlacedTransform } from '../actions';
import type { Model3D } from '../core/model3d';
import type { IconName } from '../ui/icons';
import { view } from '../ui/canvasview';
import { h } from '../ui/dom';
import { clearSnapLines, snapDelta, snapLines, snapTargets } from '../ui/snap';
import { checkbox, icon, seg } from '../ui/widgets';
import type { PInfo, Tool } from './tool';

type Handle = { u: number; v: number };
const HANDLES: Handle[] = [
  { u: 0, v: 0 }, { u: 0.5, v: 0 }, { u: 1, v: 0 }, { u: 1, v: 0.5 },
  { u: 1, v: 1 }, { u: 0.5, v: 1 }, { u: 0, v: 1 }, { u: 0, v: 0.5 },
];

type Hit = { kind: 'scale'; h: Handle } | { kind: 'rotate' } | { kind: 'move' } | { kind: 'none' };

/**
 * The bounding box being shown: `box` in the frame's own space, `m` from there to the document. One layer's box
 * turns with the layer; several selected layers share one upright box around all of theirs.
 */
interface Frame { m: Mat; box: Rect; layers: PlacedLayer[] }

/** A layer being transformed, as it was when the drag started. */
interface Target { layer: PlacedLayer; t0: Xform; maskT0?: Xform; shape0?: ShapeProps; box0?: Rect | null }

interface Drag {
  kind: 'move' | 'scale' | 'rotate';
  h?: Handle;
  p0: Pt;
  m0: Mat;
  box: Rect;
  targets: Target[];
  /** The change so far, in document space (every target's matrix is G times its starting one). */
  G: Mat;
  /** Reshaping a layer's custom box instead of transforming the layer. */
  boxEdit?: { layer: PlacedLayer; box0: Rect };
  moved: boolean;
}

/** Normalises a rect dragged past itself (negative width or height). */
const normRect = (r: Rect): Rect => ({ x: Math.min(r.x, r.x + r.w), y: Math.min(r.y, r.y + r.h), w: Math.abs(r.w), h: Math.abs(r.h) });

const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M18 9a7 7 0 1 0 1 6" fill="none" stroke="white" stroke-width="4" stroke-linecap="round"/><path d="M18 9a7 7 0 1 0 1 6" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round"/><path d="M19 4v5h-5" fill="none" stroke="white" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 4v5h-5" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>')}") 12 12, crosshair`;

function boxPoint(b: Rect, u: number, v: number): Pt { return { x: b.x + u * b.w, y: b.y + v * b.h }; }

/** The selected layers' bounding box, or null when nothing placed is selected (or a content box is still loading). */
function currentFrame(): Frame | null {
  const doc = app.doc;
  if (!doc) return null;
  const layers = doc.selectedPlaced();
  if (!layers.length) return null;
  const mode = app.opts.move.box, ready = () => view.requestOverlay();
  if (layers.length === 1) {
    const b = layerBox(layers[0], doc.pool, mode, ready);
    return b && { m: layerMatrix(layers[0]), box: b, layers };
  }
  let u: Rect | null = null;
  for (const l of layers) {
    const b = layerBox(l, doc.pool, mode, ready);
    if (!b) return null;
    u = union(u, mapRect(layerMatrix(l), b));
  }
  return { m: identity(), box: u!, layers };
}

const screenPoly = (f: Frame) => corners(f.m, f.box).map((p) => view.toScreen(p.x, p.y));

/** Top-most visible layer with a pixel (or box) under the document point. */
export function layerAt(x: number, y: number): PlacedLayer | null {
  const doc = app.doc!;
  const layers = visiblePlaced(doc.layers);
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    const b = localBounds(l, doc.pool);
    const lp = apply(invert(layerMatrix(l)), x, y);
    if (lp.x < b.x || lp.y < b.y || lp.x >= b.x + b.w || lp.y >= b.y + b.h) continue;
    // An image layer counts where it has pixels (a 3D layer's turned shape doesn't match its picture: its box counts).
    if (l.type === 'raster' && !l.model && !l.warp) {
      const a = ctx2d(doc.canvasOf(l), false).getImageData(Math.floor(lp.x), Math.floor(lp.y), 1, 1).data[3];
      if (a < 12) continue;
    }
    return l;
  }
  return null;
}

class MoveTool implements Tool {
  id = 'move'; name = 'Move & Transform'; key = 'V'; icon = 'move' as const;
  private drag: Drag | null = null;
  private wdrag: { layer: RasterLayer; i: number; moved: boolean } | null = null;

  get hint() {
    const m = app.opts.move.mode;
    return m === 'rotate3d' ? 'Drag to turn the 3D layer (left/right turns, up/down tilts) · Shift+drag spins it · Enter when done'
      : m === 'perspective' ? 'Drag the corners to fit the layer into a perspective · Enter when done · lossless until you Apply'
      : m === 'warp' ? 'Drag the grid points to bend the layer · Enter when done · lossless until you Apply'
        : this.boxEditable ? 'Drag the handles to resize the box, or inside it to move the box · the layer stays put'
          : 'Drag to move · corner handles scale (Shift = free) · outside a corner rotates · Ctrl+click layers to transform several together · arrows nudge';
  }

  private get mode() { return app.opts.move.mode; }

  activate() { app.opts.move.mode = 'transform'; }
  deactivate() { app.opts.move.mode = 'transform'; clearSnapLines(); }

  /** A turn of the active 3D layer in progress: where it started and the settings then. */
  private turn: { x: number; y: number; m: Model3D } | null = null;

  private setMode(m: 'transform' | 'perspective' | 'warp' | 'rotate3d') {
    if ((m === 'perspective' || m === 'warp') && !ensureWarp(m === 'warp' ? 'mesh' : 'perspective')) { app.emit('tool'); return; }
    app.opts.move.mode = m;
    app.emit('tool');
    view.requestOverlay();
  }

  /** The active layer's warp handles in screen space. */
  private warpHandlesScreen(l: RasterLayer) {
    const m = layerMatrix(l);
    return warpHandles(l.warp!).map((hd) => { const d = apply(m, hd.x, hd.y); return { i: hd.i, ...view.toScreen(d.x, d.y) }; });
  }

  /** Box › Custom with Edit box on: handles reshape the layer's own box instead of transforming it. */
  private editingBox = false;
  private get boxEditable() { return this.editingBox && app.opts.move.box === 'custom' && app.doc?.selectedIds().length === 1 && !!app.doc.activePlaced; }

  private hit(p: PInfo): Hit {
    const f = currentFrame();
    if (!f) return { kind: 'none' };
    for (const hd of HANDLES) {
      const bp = boxPoint(f.box, hd.u, hd.v);
      const d = apply(f.m, bp.x, bp.y);
      const s = view.toScreen(d.x, d.y);
      if (Math.hypot(s.x - p.sx, s.y - p.sy) <= 7) return { kind: 'scale', h: hd };
    }
    const poly = screenPoly(f);
    const inside = pointInPoly({ x: p.sx, y: p.sy }, poly);
    if (!inside && !this.boxEditable && poly.some((c) => Math.hypot(c.x - p.sx, c.y - p.sy) < 26)) return { kind: 'rotate' };
    return inside ? { kind: 'move' } : { kind: 'none' };
  }

  cursor(p: PInfo | null) {
    if (this.mode === 'rotate3d') return this.turn ? 'grabbing' : 'grab';
    if (this.mode !== 'transform') {
      const l = app.doc?.activeRaster;
      if (this.wdrag) return 'grabbing';
      if (p && l?.warp && this.warpHandlesScreen(l).some((s) => Math.hypot(s.x - p.sx, s.y - p.sy) <= 8)) return 'grab';
      return 'default';
    }
    if (this.drag) return this.drag.kind === 'rotate' ? ROTATE_CURSOR : this.drag.kind === 'move' ? 'move' : 'crosshair';
    if (!p) return 'default';
    const hit = this.hit(p);
    if (hit.kind === 'rotate') return ROTATE_CURSOR;
    if (hit.kind === 'scale') {
      const m = currentFrame()!.m;
      const deg = (((Math.atan2(hit.h.v - 0.5, hit.h.u - 0.5) + Math.atan2(m[1], m[0])) * 180) / Math.PI + 360) % 180;
      const opts = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'];
      return opts[Math.round(deg / 45) % 4];
    }
    return 'move';
  }

  options(bar: HTMLElement) {
    const o = app.opts.move;
    const is3D = !!app.doc?.activeRaster?.model;
    const modes = seg([
      { v: 'transform', label: 'Transform' },
      ...(is3D ? [{ v: 'rotate3d' as const, label: 'Rotate 3D', title: 'Drag on the canvas to turn the 3D layer' }]
        : [{ v: 'perspective' as const, label: 'Perspective' }, { v: 'warp' as const, label: 'Warp' }]),
    ], o.mode, (v) => this.setMode(v));
    if (o.mode === 'rotate3d') {
      bar.append(modes,
        h('button', { class: 'btn small primary', type: 'button', onclick: () => this.setMode('transform') }, 'Done'),
        h('button', { class: 'btn small', type: 'button', onclick: () => setModel({ rotX: 0, rotY: 0, rotZ: 0 }, 'Face front') }, 'Face front'),
        h('span', { class: 'opt-note' }, 'Drag to turn it · Shift+drag spins it · the light stays put, so it shades as it turns.'));
      return;
    }
    if (o.mode !== 'transform') {
      bar.append(modes,
        h('button', { class: 'btn small primary', type: 'button', onclick: () => this.setMode('transform') }, 'Done'),
        h('button', { class: 'btn small', type: 'button', title: 'Bake the warp into the pixels (needed before painting on the layer)', onclick: () => { applyWarp(); this.setMode('transform'); } }, 'Apply warp'),
        h('button', { class: 'btn small', type: 'button', onclick: () => { removeWarp(); this.setMode('transform'); } }, 'Remove warp'),
        h('span', { class: 'opt-note' }, 'The original pixels are kept: you can re-edit or remove the warp any time.'));
      return;
    }
    const boxMode = seg([
      { v: 'content', label: 'Content', title: 'Box around the layer\'s visible pixels' },
      { v: 'layer', label: 'Layer', title: 'Box around the whole layer, transparent areas included' },
      { v: 'custom', label: 'Custom', title: 'A box you size yourself, kept with the layer' },
    ], o.box, (v) => this.setBoxMode(v));
    const custom = o.box === 'custom' ? [
      h('button', {
        class: 'btn small' + (this.editingBox ? ' primary' : ''), type: 'button', title: 'Drag the handles to resize the box itself, or inside it to move it (the layer stays put)',
        onclick: () => { this.editingBox = !this.editingBox; app.emit('tool'); view.requestOverlay(); },
      }, this.editingBox ? 'Done editing box' : 'Edit box'),
      h('button', { class: 'btn small', type: 'button', title: 'Set the custom box to the visible pixels', onclick: () => this.fitCustomBox('content') }, 'Fit to content'),
      h('button', { class: 'btn small', type: 'button', title: 'Set the custom box to the whole layer', onclick: () => this.fitCustomBox('layer') }, 'Fit to layer'),
    ] : [];
    const alignBtn = (ic: IconName, title: string, run: () => void) => h('button', { class: 'icon-btn', type: 'button', title, onclick: run }, icon(ic));
    const align = h('span', { class: 'opt align-btns' },
      alignBtn('alignLeft', 'Align left edges (to the canvas when one layer is selected)', () => { void alignLayers('left'); }),
      alignBtn('alignHCenter', 'Align horizontal centres', () => { void alignLayers('hcenter'); }),
      alignBtn('alignRight', 'Align right edges', () => { void alignLayers('right'); }),
      alignBtn('alignTop', 'Align top edges', () => { void alignLayers('top'); }),
      alignBtn('alignVCenter', 'Align vertical centres', () => { void alignLayers('vcenter'); }),
      alignBtn('alignBottom', 'Align bottom edges', () => { void alignLayers('bottom'); }),
      alignBtn('distH', 'Distribute horizontally: equal gaps between three or more layers', () => { void distributeLayers('h'); }),
      alignBtn('distV', 'Distribute vertically: equal gaps between three or more layers', () => { void distributeLayers('v'); }));
    bar.append(
      modes,
      h('span', { class: 'opt' }, h('span', { class: 'opt-label' }, 'Box'), boxMode),
      ...custom,
      h('span', { class: 'opt-sep' }),
      align,
      h('span', { class: 'opt-sep' }),
      checkbox('Auto-select layer', o.autoSelect, (v) => { o.autoSelect = v; app.saveOpts(); }, 'Click picks the layer under the cursor (Ctrl+click does this any time; add Shift to add it to the selection)'),
      checkbox('Snap', app.prefs.snap, (v) => app.setPrefs({ snap: v }), 'Snap to guides, the canvas edges and centre, and other layers'),
      h('span', { class: 'opt-sep' }),
      h('button', { class: 'btn small', type: 'button', title: 'Flip layer horizontally', onclick: () => flipLayer('h') }, icon('flipH'), 'Flip H'),
      h('button', { class: 'btn small', type: 'button', title: 'Flip layer vertically', onclick: () => flipLayer('v') }, icon('flipV'), 'Flip V'),
      h('button', { class: 'btn small', type: 'button', title: 'Rotate layer 90° clockwise', onclick: () => rotateLayer90(1) }, icon('rotate'), '90°'),
      h('button', { class: 'btn small', type: 'button', title: 'Back to original size and angle', onclick: () => resetTransform() }, 'Reset transform'),
      h('span', { class: 'opt-note' }, 'Transforms are lossless: layers keep their original pixels.'),
    );
  }

  private setBoxMode(v: 'content' | 'layer' | 'custom') {
    app.opts.move.box = v;
    app.saveOpts();
    if (v !== 'custom') this.editingBox = false;
    // A layer without a custom box starts from its content box.
    else if (app.doc?.selectedPlaced().some((l) => !l.box)) this.fitCustomBox('content', true);
    app.emit('tool');
    view.requestOverlay();
  }

  /** Sets the selected layers' custom boxes to their content or whole-layer box. */
  private fitCustomBox(to: 'content' | 'layer', onlyMissing = false) {
    const doc = app.doc;
    if (!doc) return;
    let changed = false;
    for (const l of doc.selectedPlaced()) {
      if (onlyMissing && l.box) continue;
      const b = layerBox(l, doc.pool, to) ?? localBounds(l, doc.pool);
      l.box = { ...b };
      changed = true;
    }
    if (changed) doc.commit(to === 'content' ? 'Fit box to content' : 'Fit box to layer');
    view.requestOverlay();
  }

  down(p: PInfo) {
    const doc = app.doc!;
    if (this.mode === 'rotate3d') {
      const m = doc.activeRaster?.model;
      if (m) this.turn = { x: p.sx, y: p.sy, m: { ...m } };
      return;
    }
    if (this.mode !== 'transform') {
      const l = ensureWarp(this.mode === 'warp' ? 'mesh' : 'perspective');
      if (!l) return;
      const near = this.warpHandlesScreen(l).find((s) => Math.hypot(s.x - p.sx, s.y - p.sy) <= 8);
      if (near) this.wdrag = { layer: l, i: near.i, moved: false };
      return;
    }
    let hit = this.hit(p);
    if ((app.opts.move.autoSelect || p.ctrl) && hit.kind !== 'scale' && hit.kind !== 'rotate') {
      const l = layerAt(p.x, p.y);
      if (l) {
        // Shift adds the layer to the selection (or takes it out); clicking one already selected keeps the rest.
        if (p.shift) doc.toggleSelected(l.id);
        else if (!doc.selectedPlaced().some((x) => x.id === l.id)) doc.setActive(l.id);
        doc.touch('meta');
        hit = { kind: 'move' };
      }
    }
    const f = currentFrame();
    if (!f) return;
    const base = { h: hit.kind === 'scale' ? hit.h : undefined, p0: { x: p.x, y: p.y }, m0: f.m, box: f.box, G: identity(), moved: false };
    if (this.boxEditable) {
      if (hit.kind !== 'scale' && hit.kind !== 'move') return;
      const l = f.layers[0];
      this.drag = { ...base, kind: hit.kind, targets: [], boxEdit: { layer: l, box0: { ...f.box } } };
      return;
    }
    this.drag = {
      ...base, kind: hit.kind === 'none' ? 'move' : hit.kind,
      targets: f.layers.map((l) => ({
        layer: l, t0: { ...l.t }, maskT0: l.mask ? { ...l.mask.t } : undefined,
        shape0: l.type === 'shape' ? { ...l.shape } : undefined, box0: l.box ? { ...l.box } : undefined,
      })),
    };
  }

  /** Reshapes or moves a custom box, in the layer's own pixels. */
  private moveBox(d: Drag, p: PInfo) {
    const { layer, box0 } = d.boxEdit!;
    const inv = invert(layerMatrix(layer));
    const a = apply(inv, d.p0.x, d.p0.y), b = apply(inv, p.x, p.y);
    if (d.kind === 'move') layer.box = { ...box0, x: box0.x + b.x - a.x, y: box0.y + b.y - a.y };
    else {
      const hd = d.h!;
      let x0 = box0.x, y0 = box0.y, x1 = box0.x + box0.w, y1 = box0.y + box0.h;
      if (hd.u === 0) x0 = b.x; else if (hd.u === 1) x1 = b.x;
      if (hd.v === 0) y0 = b.y; else if (hd.v === 1) y1 = b.y;
      layer.box = normRect({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    d.moved = true;
    app.doc!.touch('meta');
  }

  move(p: PInfo) {
    if (this.turn) {
      // Half a degree per screen pixel; angles stay within -180..180.
      const t = this.turn, dx = p.sx - t.x, dy = p.sy - t.y;
      const wrap = (v: number) => Math.round(((((v + 180) % 360) + 360) % 360) - 180);
      setModel(p.shift ? { rotZ: wrap(t.m.rotZ + dx * 0.5) } : { rotY: wrap(t.m.rotY + dx * 0.5), rotX: wrap(t.m.rotX - dy * 0.5) });
      return;
    }
    if (this.wdrag) {
      const w = this.wdrag;
      const lp = apply(invert(layerMatrix(w.layer)), p.x, p.y);
      const pts = [...w.layer.warp!.pts];
      pts[w.i * 2] = lp.x;
      pts[w.i * 2 + 1] = lp.y;
      w.layer.warp = { ...w.layer.warp!, pts };
      w.moved = true;
      app.doc!.touch('meta');
      return;
    }
    const d = this.drag;
    if (!d) return;
    if (d.boxEdit) { this.moveBox(d, p); return; }
    d.moved = true;
    // Every kind of drag comes down to one change G in document space, applied to each selected layer.
    let k: { x: number; y: number; anchor: Pt } | null = null, turn = 0;
    if (d.kind === 'move') {
      let dx = p.x - d.p0.x, dy = p.y - d.p0.y;
      if (p.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      clearSnapLines();
      if (app.prefs.snap && !p.ctrl) {
        // Line the box's edges or centre up with guides, the canvas and other layers.
        const b = mapRect(mul(translate(dx, dy), d.m0), d.box);
        const { xs, ys } = snapTargets(d.targets.map((t) => t.layer.id));
        const tol = 6 / app.doc!.zoom;
        const sx = p.shift && dx === 0 ? null : snapDelta([b.x, b.x + b.w / 2, b.x + b.w], xs, tol);
        const sy = p.shift && dy === 0 ? null : snapDelta([b.y, b.y + b.h / 2, b.y + b.h], ys, tol);
        if (sx) { dx += sx.d; snapLines.x = [sx.at]; }
        if (sy) { dy += sy.d; snapLines.y = [sy.at]; }
      }
      d.G = translate(dx, dy);
    } else if (d.kind === 'scale') {
      const hd = d.h!;
      const corner = hd.u !== 0.5 && hd.v !== 0.5;
      const anchor = p.alt ? boxPoint(d.box, 0.5, 0.5) : boxPoint(d.box, 1 - hd.u, 1 - hd.v);
      const hl = boxPoint(d.box, hd.u, hd.v);
      const pl = apply(invert(d.m0), p.x, p.y);
      const D = { x: hl.x - anchor.x, y: hl.y - anchor.y };
      const Q = { x: pl.x - anchor.x, y: pl.y - anchor.y };
      let kx = hd.u === 0.5 ? 1 : Q.x / (D.x || 1e-9);
      let ky = hd.v === 0.5 ? 1 : Q.y / (D.y || 1e-9);
      if (corner && !p.shift) kx = ky = (Q.x * D.x + Q.y * D.y) / (D.x * D.x + D.y * D.y || 1e-9);
      const fix = (v: number) => (Math.abs(v) < 0.002 ? (v < 0 ? -0.002 : 0.002) : v);
      kx = fix(kx); ky = fix(ky);
      k = { x: kx, y: ky, anchor };
      // Scale about the anchor in the box's own axes.
      d.G = mul(mul(d.m0, mul(translate(anchor.x, anchor.y), mul(scale(kx, ky), translate(-anchor.x, -anchor.y)))), invert(d.m0));
    } else {
      const cl = boxPoint(d.box, 0.5, 0.5);
      const cd = apply(d.m0, cl.x, cl.y);
      let a = Math.atan2(p.y - cd.y, p.x - cd.x) - Math.atan2(d.p0.y - cd.y, d.p0.x - cd.x);
      if (p.shift) {
        // Steps of 15°: of the layer's angle for one layer, of the turn for several.
        const step = Math.PI / 12, r0 = d.targets.length === 1 ? d.targets[0].t0.rot : 0;
        a = Math.round((r0 + a) / step) * step - r0;
      }
      d.G = mul(translate(cd.x, cd.y), mul(xformMatrix({ x: 0, y: 0, sx: 1, sy: 1, rot: a }), translate(-cd.x, -cd.y)));
      turn = a;
    }
    const single = d.targets.length === 1;
    for (const t of d.targets) {
      const l = t.layer;
      // Moves, turns and one layer's scaling are written straight into the transform (flips keep their sign);
      // scaling several layers goes through the matrix.
      if (d.kind === 'move') l.t = { ...t.t0, x: t.t0.x + d.G[4], y: t.t0.y + d.G[5] };
      else if (d.kind === 'rotate') l.t = { ...t.t0, rot: t.t0.rot + turn, ...apply(d.G, t.t0.x, t.t0.y) };
      else if (k && single) {
        const ad = apply(d.m0, k.anchor.x, k.anchor.y);
        const off = apply(xformMatrix({ ...t.t0, x: 0, y: 0, sx: t.t0.sx * k.x, sy: t.t0.sy * k.y }), k.anchor.x, k.anchor.y);
        if (l.type === 'shape' && t.shape0 && t.shape0.kind !== 'path') {
          // A shape stays vector: its geometry is resized instead of stretched (keeps the stroke width).
          l.shape = { ...t.shape0, w: t.shape0.w * k.x, h: t.shape0.h * k.y };
          l.t = { ...t.t0, x: ad.x - off.x, y: ad.y - off.y };
          if (t.box0) l.box = normRect({ x: t.box0.x * k.x, y: t.box0.y * k.y, w: t.box0.w * k.x, h: t.box0.h * k.y });
        } else l.t = { ...t.t0, sx: t.t0.sx * k.x, sy: t.t0.sy * k.y, x: ad.x - off.x, y: ad.y - off.y };
      } else l.t = decompose(mul(d.G, xformMatrix(t.t0)));
      if (l.mask && t.maskT0) l.mask.t = decompose(mul(d.G, xformMatrix(t.maskT0)));
    }
    app.doc!.touch('meta');
  }

  up() {
    clearSnapLines();
    if (this.turn) { this.turn = null; app.doc?.commit('Rotate 3D'); return; }
    if (this.wdrag) {
      const w = this.wdrag;
      this.wdrag = null;
      if (w.moved) app.doc!.commit(this.mode === 'warp' ? 'Warp' : 'Perspective');
      return;
    }
    const d = this.drag;
    this.drag = null;
    if (!d || !d.moved) return;
    if (d.boxEdit) { app.doc!.commit('Adjust box'); return; }
    app.doc!.commit(d.kind === 'move' ? 'Move' : d.kind === 'scale' ? 'Scale' : 'Rotate');
  }

  keydown(e: KeyboardEvent) {
    if (this.mode !== 'transform' && (e.key === 'Enter' || e.key === 'Escape')) { this.setMode('transform'); return true; }
    const f = currentFrame();
    if (!f) return false;
    const step = e.shiftKey ? 10 : 1;
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!dir) return false;
    for (const l of f.layers) setPlacedTransform(l, { ...l.t, x: l.t.x + dir[0] * step, y: l.t.y + dir[1] * step });
    app.doc!.commit('Nudge');
    return true;
  }

  /** Warp/perspective editing: the bent grid (sampled from the warp itself) and its control points. */
  private warpOverlay(ctx: CanvasRenderingContext2D, l: RasterLayer, accent: string) {
    const w = l.warp!;
    const m = layerMatrix(l);
    const sp = (u: number, v: number) => { const q = warpPoint(w, u, v); const d = apply(m, q.x, q.y); return view.toScreen(d.x, d.y); };
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = accent;
    const lines = w.kind === 'perspective' ? 2 : w.n;
    const N = 32;
    for (let k = 0; k < lines; k++) {
      const t = k / (lines - 1);
      for (const along of [0, 1]) {
        ctx.beginPath();
        for (let i = 0; i <= N; i++) {
          const s = i / N;
          const pt = along ? sp(t, s) : sp(s, t);
          if (i) ctx.lineTo(pt.x, pt.y); else ctx.moveTo(pt.x, pt.y);
        }
        ctx.stroke();
      }
    }
    for (const hd of this.warpHandlesScreen(l)) {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(hd.x, hd.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  overlay(ctx: CanvasRenderingContext2D) {
    const accentNow = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2EE6BE';
    if (this.mode !== 'transform') {
      const r = app.doc?.activeRaster;
      if (r?.warp && r.visible) this.warpOverlay(ctx, r, accentNow);
      return;
    }
    const f = currentFrame();
    if (!f) return;
    // While dragging, the box follows the change (several layers' box isn't re-fitted until the drag ends).
    const d = this.drag;
    const m = d && !d.boxEdit ? mul(d.G, d.m0) : f.m;
    const box = d && !d.boxEdit ? d.box : f.box;
    const poly = corners(m, box).map((p) => view.toScreen(p.x, p.y));
    const editing = this.boxEditable;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = accentNow;
    if (editing) ctx.setLineDash([5, 4]);
    ctx.beginPath();
    poly.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    for (const hd of HANDLES) {
      const lp = boxPoint(box, hd.u, hd.v);
      const q = apply(m, lp.x, lp.y);
      const s = view.toScreen(q.x, q.y);
      ctx.fillStyle = editing ? accentNow : '#fff';
      ctx.fillRect(Math.round(s.x) - 3.5, Math.round(s.y) - 3.5, 7, 7);
      ctx.strokeRect(Math.round(s.x) - 3.5, Math.round(s.y) - 3.5, 7, 7);
    }
    if (d?.moved) {
      // Size while scaling, angle while turning, position of the box's corner while moving.
      const w = Math.abs(box.w * Math.hypot(m[0], m[1])), hh = Math.abs(box.h * Math.hypot(m[2], m[3]));
      const tl = apply(m, box.x, box.y);
      const label = d.boxEdit ? `Box ${Math.round(w)} × ${Math.round(hh)} px`
        : d.kind === 'rotate' ? `${((((d.targets.length === 1 ? d.targets[0].layer.t.rot : Math.atan2(d.G[1], d.G[0])) * 180) / Math.PI) % 360).toFixed(1)}°`
          : d.kind === 'scale' ? `${Math.round(w)} × ${Math.round(hh)} px`
            : `X ${Math.round(tl.x)}  Y ${Math.round(tl.y)}`;
      const c = poly[2];
      ctx.font = '600 12px "Segoe UI", sans-serif';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(10,14,13,.85)';
      ctx.fillRect(c.x + 10, c.y + 8, tw + 12, 20);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, c.x + 16, c.y + 22);
    }
    ctx.restore();
  }
}

export const moveTool = new MoveTool();
