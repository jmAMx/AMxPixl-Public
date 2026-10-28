import { app } from '../app';
import { newId } from '../core/document';
import { layerMatrix, localBounds } from '../core/layers';
import { corners } from '../core/math';
import type { TextLayer, TextProps } from '../core/types';
import { view } from '../ui/canvasview';
import { h } from '../ui/dom';
import { allFontsLoaded, fontList, loadInstalledFonts } from '../ui/fonts';
import { checkbox, icon, numField, seg } from '../ui/widgets';
import { warpDialog } from '../ui/warpdialog';
import { layerAt } from './move';
import type { PInfo, Tool } from './tool';

class TextTool implements Tool {
  id = 'text'; name = 'Text'; key = 'T'; icon = 'text' as const;
  hint = 'Click to add text, or click existing text to edit it · Ctrl+Enter or Esc finishes';
  private editor: HTMLElement | null = null;
  private editing: { layer: TextLayer; isNew: boolean } | null = null;

  cursor() { return 'text'; }

  deactivate() { this.finish(); }

  private get activeText(): TextLayer | null {
    const a = app.doc?.active;
    return a?.type === 'text' ? a : null;
  }

  /** Applies a style change to the text being edited/selected, and remembers it for new text. */
  private style(patch: Partial<TextProps>) {
    const o = app.opts.text as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) if (k in o) o[k] = v;
    app.saveOpts();
    const l = this.activeText;
    if (l) {
      l.text = { ...l.text, ...patch };
      app.doc!.touch('meta');
      if (!this.editing) app.doc!.commit('Text style');
    }
  }

  options(bar: HTMLElement) {
    const o = app.opts.text;
    const cur = this.activeText?.text;
    const font = cur?.font ?? o.font;
    const sel = h('select', { class: 'font-select', onchange: async () => {
      if (sel.value === '__more') {
        sel.value = font;
        if (await loadInstalledFonts()) app.emit('tool');
        return;
      }
      this.style({ font: sel.value });
    } },
    ...fontList().map((f) => h('option', { value: f, selected: f === font, style: `font-family:"${f}"` }, f)),
    allFontsLoaded() ? null : h('option', { value: '__more' }, 'Show all installed fonts…'));
    bar.append(
      sel,
      numField('Size', cur?.size ?? o.size, (v) => this.style({ size: v }), { unit: 'px', min: 1, max: 2000 }),
      seg([{ v: '400', label: 'Regular' }, { v: '700', label: 'Bold' }], String(cur?.weight ?? o.weight) as '400' | '700', (v) => this.style({ weight: Number(v) })),
      seg([{ v: 'n', label: 'Normal' }, { v: 'i', label: 'Italic' }], (cur?.italic ?? o.italic) ? 'i' : 'n', (v) => this.style({ italic: v === 'i' })),
      seg([{ v: 'left', icon: 'alignL', title: 'Align left' }, { v: 'center', icon: 'alignC', title: 'Centre' }, { v: 'right', icon: 'alignR', title: 'Align right' }], cur?.align ?? o.align, (v) => this.style({ align: v })),
      h('button', { class: 'btn small', type: 'button', title: 'Use the foreground colour for this text', onclick: () => this.style({ color: app.fg }) },
        h('span', { class: 'chip-swatch', style: `background:${app.fg}` }), 'Apply colour'),
      checkbox('Anti-alias', cur ? cur.antiAlias !== false : o.antiAlias, (v) => this.style({ antiAlias: v }), 'Turn off for hard pixel edges (pixel art and pixel fonts)'),
      h('button', {
        class: 'btn small', type: 'button', disabled: !this.activeText, title: 'Bend the text into an arc, flag, bulge… (it stays editable)',
        onclick: () => { this.finish(); void warpDialog(); },
      }, icon('warp'), 'Warp…'),
    );
  }

  down(p: PInfo) {
    const doc = app.doc!;
    this.finish();
    const hit = layerAt(p.x, p.y);
    if (hit?.type === 'text') {
      doc.activeId = hit.id;
      doc.touch('meta');
      this.edit(hit, false);
      return;
    }
    const o = app.opts.text;
    const l: TextLayer = {
      id: newId(), type: 'text', name: 'Text', visible: true, opacity: 1, blend: 'normal',
      t: { x: Math.round(p.x), y: Math.round(p.y - o.size * 0.8), sx: 1, sy: 1, rot: 0 },
      text: { content: '', font: o.font, size: o.size, weight: o.weight, italic: o.italic, color: app.fg, align: o.align, lineHeight: 1.2, tracking: 0, ...(o.antiAlias ? {} : { antiAlias: false }) },
    };
    doc.insertLayer(l);
    doc.touch('meta');
    this.edit(l, true);
  }

  private edit(layer: TextLayer, isNew: boolean) {
    this.editing = { layer, isNew };
    const ta = h('textarea', { class: 'text-editor-input', rows: 3, spellcheck: false, placeholder: 'Type your text…', value: layer.text.content });
    ta.addEventListener('input', () => {
      layer.text = { ...layer.text, content: ta.value };
      layer.name = ta.value.split('\n')[0].slice(0, 32) || 'Text';
      app.doc!.touch('meta');
      this.position();
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); this.finish(); }
    });
    this.editor = h('div', { class: 'text-editor' }, ta, h('div', { class: 'text-editor-hint' }, 'Ctrl+Enter to finish'));
    view.el.append(this.editor);
    this.position();
    app.emit('tool');
    ta.focus();
    ta.select();
    requestAnimationFrame(() => { if (document.activeElement !== ta && this.editor) ta.focus(); });
  }

  private position() {
    if (!this.editor || !this.editing) return;
    const l = this.editing.layer;
    const pts = corners(layerMatrix(l), localBounds(l, app.doc!.pool)).map((c) => view.toScreen(c.x, c.y));
    const x = Math.min(...pts.map((p) => p.x)), y = Math.max(...pts.map((p) => p.y));
    const { w, h: hh } = view.size;
    this.editor.style.left = `${Math.max(8, Math.min(w - 280, x))}px`;
    this.editor.style.top = `${Math.max(8, Math.min(hh - 120, y + 10))}px`;
  }

  finish() {
    const e = this.editing;
    if (!e) return;
    this.editing = null;
    this.editor?.remove();
    this.editor = null;
    const doc = app.doc;
    if (!doc || !doc.layer(e.layer.id)) return;
    if (!e.layer.text.content.trim()) {
      if (e.isNew) { doc.revert(); return; }
      doc.removeLayer(e.layer.id);
      doc.commit('Delete text');
      return;
    }
    doc.commit(e.isNew ? 'Add text' : 'Edit text');
    app.emit('tool');
  }

  keydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && this.activeText && !this.editing) { this.edit(this.activeText, false); return true; }
    return false;
  }

  overlay(ctx: CanvasRenderingContext2D) {
    const l = this.editing?.layer ?? this.activeText;
    if (!l) return;
    const pts = corners(layerMatrix(l), localBounds(l, app.doc!.pool)).map((c) => view.toScreen(c.x, c.y));
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2EE6BE';
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
}

export const textTool = new TextTool();
