import { glops } from './glops';
import { ctx2d } from './layers';
import { acquire, composite, like, release } from './scratch';
import type { LayerStyles } from './types';

export function defaultStyles(): LayerStyles {
  return {
    shadow: { on: false, color: '#000000', opacity: 0.6, angle: 120, distance: 10, size: 14 },
    glow: { on: false, color: '#2ee6be', opacity: 0.75, size: 18 },
    innerGlow: { on: false, color: '#ffffff', opacity: 0.6, size: 10 },
    stroke: { on: false, color: '#ffffff', opacity: 1, size: 4, position: 'outside' },
    overlay: { on: false, color: '#ff4a1a', opacity: 1 },
  };
}

export const hasStyles = (s: LayerStyles | null | undefined): s is LayerStyles =>
  !!s && (s.shadow.on || s.glow.on || s.innerGlow.on || s.stroke.on || s.overlay.on);

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** The layer's shape filled with one colour. */
function silhouette(src: HTMLCanvasElement, color: string) {
  const s = like(src);
  const x = ctx2d(s);
  x.drawImage(src, 0, 0);
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = color;
  x.fillRect(0, 0, s.width, s.height);
  return s;
}

/**
 * The shape grown (r > 0) or shrunk (r < 0) by |r| pixels, filled with `color`: blur the shape, then threshold it.
 * A Gaussian with sigma = r/2 falls to ~2.3% at distance r outside an edge (and ~97.7% at r inside).
 */
function morph(src: HTMLCanvasElement, r: number, color: string): HTMLCanvasElement {
  const out = like(src);
  if (Math.abs(r) < 0.3) {
    const sil = silhouette(src, color);
    composite(out, sil, 'normal', 1);
    release(sil);
    return out;
  }
  const b = like(src);
  composite(b, src, 'normal', 1, 'source-over', `blur(${Math.abs(r) / 2}px)`);
  const res = r > 0 ? glops.ramp(b, 0.012, 0.035, rgb(color)) : glops.ramp(b, 0.965, 0.99, rgb(color));
  if (res) composite(out, res, 'normal', 1, 'copy');
  release(b);
  return out;
}

/**
 * Draws `content` (a layer's pixels, already masked) with its styles into a new buffer, in Photoshop's order:
 * shadow and outer glow beneath, then the content with colour overlay and inner glow, then the stroke.
 * `scale` is output pixels per document pixel. The caller releases the returned canvas.
 */
export function applyStyles(content: HTMLCanvasElement, s: LayerStyles, scale: number): HTMLCanvasElement {
  const out = like(content);
  if (s.shadow.on) {
    const sh = silhouette(content, s.shadow.color);
    const a = (s.shadow.angle * Math.PI) / 180;
    const d = s.shadow.distance * scale;
    composite(out, sh, 'normal', s.shadow.opacity, 'source-over', s.shadow.size > 0 ? `blur(${(s.shadow.size * scale) / 2}px)` : undefined, -Math.cos(a) * d, Math.sin(a) * d);
    release(sh);
  }
  if (s.glow.on) {
    const g = silhouette(content, s.glow.color);
    composite(out, g, 'normal', s.glow.opacity, 'source-over', `blur(${Math.max(0.5, (s.glow.size * scale) / 2)}px)`);
    release(g);
  }
  const body = like(content);
  composite(body, content, 'normal', 1);
  if (s.overlay.on) {
    const x = ctx2d(body);
    x.save();
    x.globalCompositeOperation = 'source-atop';
    x.globalAlpha = s.overlay.opacity;
    x.fillStyle = s.overlay.color;
    x.fillRect(0, 0, body.width, body.height);
    x.restore();
  }
  if (s.innerGlow.on) {
    // Light coming in from the edges: the inverse of the shape, blurred, kept inside the shape.
    const inv = like(content);
    const x = ctx2d(inv);
    x.fillStyle = s.innerGlow.color;
    x.fillRect(0, 0, inv.width, inv.height);
    x.globalCompositeOperation = 'destination-out';
    x.drawImage(content, 0, 0);
    const g = acquire(inv.width, inv.height);
    composite(g, inv, 'normal', 1, 'source-over', `blur(${Math.max(0.5, (s.innerGlow.size * scale) / 2)}px)`);
    composite(g, content, 'normal', 1, 'destination-in');
    composite(body, g, 'normal', s.innerGlow.opacity, 'source-atop');
    release(inv, g);
  }
  composite(out, body, 'normal', 1);
  release(body);
  if (s.stroke.on && s.stroke.size > 0) {
    const r = s.stroke.size * scale;
    const [outer, inner] = s.stroke.position === 'outside' ? [r, 0] : s.stroke.position === 'inside' ? [0, -r] : [r / 2, -r / 2];
    const ring = morph(content, outer, s.stroke.color);
    if (inner < 0) {
      const core = morph(content, inner, '#ffffff');
      composite(ring, core, 'normal', 1, 'destination-out');
      release(core);
    } else {
      composite(ring, content, 'normal', 1, 'destination-out');
    }
    composite(out, ring, 'normal', s.stroke.opacity);
    release(ring);
  }
  return out;
}
