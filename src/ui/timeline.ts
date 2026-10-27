import { app } from '../app';
import * as A from '../actions';
import { newCanvas } from '../core/layers';
import { renderDoc } from '../core/render';
import { view } from './canvasview';
import { h } from './dom';
import { animExportDialog } from './dialogs';
import { checkbox, icon, numField, popupMenu, type MenuItem } from './widgets';

/**
 * The Timeline: frames of the current document's animation along the bottom of the window, with playback,
 * frame lengths, onion skinning and drag-to-reorder. Each frame remembers which layers it shows; the eye
 * buttons in Layers edit the selected frame.
 */

const THUMB_H = 54;

// ---------- playback ----------

let timer = 0;
export let playing = false;

export function play() {
  const doc = app.doc;
  if (!doc?.anim || playing) return;
  playing = app.playing = true;
  app.emit('frame');
  const step = () => {
    const d = app.doc;
    const a = d?.anim;
    if (!playing || !d || !a || d !== doc) { stop(); return; }
    const ms = a.frames[d.frame]?.ms ?? 1000 / a.fps;
    timer = window.setTimeout(() => {
      if (!playing) return;
      const last = d.frame >= a.frames.length - 1;
      if (last && !a.loop) { stop(); return; }
      A.goToFrame(last ? 0 : d.frame + 1);
      step();
    }, ms);
  };
  step();
}

export function stop() {
  if (!playing) return;
  playing = app.playing = false;
  clearTimeout(timer);
  app.emit('frame');
}

export const togglePlay = () => (playing ? stop() : play());

// ---------- panel ----------

export function timelinePanel() {
  const el = h('section', { class: 'timeline' });
  const strip = h('div', { class: 'tl-frames' });
  const thumbs: HTMLCanvasElement[] = [];
  let thumbTimer = 0;
  let sig = '';

  const drawThumbs = () => {
    const doc = app.doc;
    if (!doc?.anim || playing) return;
    const s = THUMB_H / doc.height;
    doc.anim.frames.forEach((_, i) => {
      const c = thumbs[i];
      if (!c) return;
      renderDoc(doc, c, [s, 0, 0, s, 0, 0], { frame: i });
    });
  };
  const scheduleThumbs = (delay = 300) => { clearTimeout(thumbTimer); thumbTimer = window.setTimeout(drawThumbs, delay); };

  const lengthMenu = (i: number, x: number, y: number) => {
    const doc = app.doc!;
    const a = doc.anim!;
    const cur = a.frames[i].ms;
    const items: MenuItem[] = [
      { label: `Frame rate (${Math.round(1000 / a.fps)} ms)`, checked: cur === undefined, onClick: () => A.setFrameMs(i, undefined) },
      { sep: true },
      ...[40, 80, 100, 150, 200, 500, 1000, 2000].map((ms) => ({ label: ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`, checked: cur === ms, onClick: () => A.setFrameMs(i, ms) })),
    ];
    popupMenu(items, x, y);
  };

  const build = () => {
    const doc = app.doc;
    el.hidden = !doc || !app.prefs.dock.timeline;
    if (el.hidden) return;
    const a = doc!.anim;
    if (!a) {
      el.replaceChildren(h('div', { class: 'tl-empty' },
        icon('film'),
        h('span', null, 'No animation yet.'),
        h('button', { class: 'btn small', type: 'button', title: 'One frame per layer (bottom layer stays as a background)', onclick: () => A.createAnimation('layers', { keepBottom: true }) }, 'Frames from layers'),
        h('button', { class: 'btn small', type: 'button', title: '24 frames that all show the same layers, for animated effects', onclick: () => A.createAnimation('loop') }, 'Effects loop'),
        h('span', { class: 'grow' }),
        h('button', { class: 'icon-btn', type: 'button', title: 'Close the timeline', onclick: () => app.setPrefs({ dock: { ...app.prefs.dock, timeline: false } }) }, icon('close'))));
      return;
    }
    const d = doc!;
    const total = a.frames.reduce((t, f) => t + (f.ms ?? 1000 / a.fps), 0);
    const bar = h('div', { class: 'tl-bar' },
      h('button', { class: 'icon-btn', type: 'button', title: 'Previous frame (,)', onclick: () => { stop(); A.goToFrame(d.frame - 1); } }, icon('prev')),
      h('button', { class: 'icon-btn tl-play', type: 'button', title: playing ? 'Pause (Enter)' : 'Play (Enter)', onclick: togglePlay }, icon(playing ? 'pause' : 'play')),
      h('button', { class: 'icon-btn', type: 'button', title: 'Next frame (.)', onclick: () => { stop(); A.goToFrame(d.frame + 1); } }, icon('next')),
      h('span', { class: 'tl-count' }, `${d.frame + 1} / ${a.frames.length}`),
      numField('FPS', a.fps, (v) => A.setAnim({ fps: v }, 'Frame rate'), { min: 1, max: 60 }),
      h('span', { class: 'dim tl-len' }, `${(total / 1000).toFixed(2)} s`),
      checkbox('Loop', a.loop, (v) => A.setAnim({ loop: v }, v ? 'Loop on' : 'Loop off')),
      h('button', { class: 'icon-btn' + (app.prefs.onion ? ' on' : ''), type: 'button', title: 'Onion skin: faintly show the frames before and after', onclick: () => app.setPrefs({ onion: !app.prefs.onion }) }, icon('onion')),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn small', type: 'button', title: 'Copy this frame after itself', onclick: A.duplicateFrame }, icon('duplicate'), 'Frame'),
      h('button', { class: 'icon-btn', type: 'button', title: 'Delete this frame', onclick: A.deleteFrame }, icon('trash')),
      h('button', { class: 'btn small primary', type: 'button', onclick: animExportDialog }, 'Export…'),
      h('button', { class: 'icon-btn', type: 'button', title: 'More', onclick: (e: MouseEvent) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        popupMenu([
          { label: 'Remake frames from layers', onClick: () => A.createAnimation('layers', { keepBottom: true }) },
          { label: 'Remove animation', onClick: A.removeAnimation },
          { sep: true },
          { label: 'Close timeline', onClick: () => app.setPrefs({ dock: { ...app.prefs.dock, timeline: false } }) },
        ], r.left - 150, r.top - 110);
      } }, icon('settings')));
    thumbs.length = 0;
    let dragFrom = -1;
    strip.replaceChildren(...a.frames.map((f, i) => {
      const c = newCanvas(Math.max(1, Math.round((d.width * THUMB_H) / d.height)), THUMB_H);
      thumbs.push(c);
      const ms = f.ms ?? 1000 / a.fps;
      const len = h('button', { class: 'tl-ms' + (f.ms !== undefined ? ' own' : ''), type: 'button', title: 'How long this frame shows', onclick: (e: MouseEvent) => { e.stopPropagation(); lengthMenu(i, e.clientX, e.clientY - 220); } },
        ms >= 1000 ? `${+(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
      const cell = h('div', { class: 'tl-frame' + (i === d.frame ? ' on' : ''), draggable: true, title: `Frame ${i + 1}`,
        onclick: () => { stop(); A.goToFrame(i); } },
      h('span', { class: 'tl-n' }, String(i + 1)), c, len);
      cell.addEventListener('dragstart', (e) => { dragFrom = i; e.dataTransfer?.setData('text/plain', String(i)); });
      cell.addEventListener('dragover', (e) => { if (dragFrom >= 0) { e.preventDefault(); cell.classList.add('drop'); } });
      cell.addEventListener('dragleave', () => cell.classList.remove('drop'));
      cell.addEventListener('drop', (e) => { e.preventDefault(); cell.classList.remove('drop'); if (dragFrom >= 0) A.moveFrame(dragFrom, i); dragFrom = -1; });
      return cell;
    }));
    el.replaceChildren(bar, strip);
    scheduleThumbs(30);
    strip.children[d.frame]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  // Rebuild when the animation's structure changes; a new current frame only moves the highlight.
  const signature = () => {
    const d = app.doc;
    return JSON.stringify([!!d, app.prefs.dock.timeline, app.prefs.onion, playing, d?.anim ? [d.anim.fps, d.anim.loop, d.anim.frames.map((f) => [f.id, f.ms])] : null, d?.width, d?.height]);
  };
  const mark = () => {
    const d = app.doc;
    if (!d?.anim) return;
    [...strip.children].forEach((c, i) => c.classList.toggle('on', i === d.frame));
    const count = el.querySelector('.tl-count');
    if (count) count.textContent = `${d.frame + 1} / ${d.anim.frames.length}`;
    strip.children[d.frame]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  const update = (force = false) => {
    const s = signature();
    if (force || s !== sig) { sig = s; build(); return; }
    mark();
    if (!playing) scheduleThumbs();
  };
  app.on('docs', () => { stop(); update(true); });
  app.on('prefs', () => update());
  app.on('frame', () => update());
  app.on('change', ({ doc, kind }) => { if (doc === app.doc && !(playing && kind === 'meta')) update(); });
  // Keyboard: Enter plays/pauses, comma/period step frames (when not typing).
  window.addEventListener('keydown', (e) => {
    const d = app.doc;
    if (!d?.anim || el.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (app.tool?.id === 'pen') return; // Enter finishes a path there
    if (e.key === 'Enter') { e.preventDefault(); togglePlay(); }
    else if (e.key === ',') { e.preventDefault(); stop(); A.goToFrame(d.frame - 1); }
    else if (e.key === '.') { e.preventDefault(); stop(); A.goToFrame(d.frame + 1); }
  });
  view.el.addEventListener('pointerdown', () => stop(), true);
  update(true);
  return el;
}
