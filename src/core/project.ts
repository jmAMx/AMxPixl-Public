import { History, type Doc } from './document';
import type { FileRef } from './fileio';
import type { Rect } from './math';

/** An artboard: an image, and where its top-left corner sits among the file's other artboards. */
export interface Board { doc: Doc; x: number; y: number }

/** The artboards as a step records them: which, where, and their names (so renaming is undone too). */
type Layout = { doc: Doc; x: number; y: number; name: string }[];

/**
 * A file, open in one tab: one or more artboards, each its own image (a Doc, with its own size, layers, selection and
 * pixels), so everything that works on an image works on an artboard as it is. The artboards share one undo history,
 * in the order the steps were made, and are saved, recovered and closed together. A plain image is a file with one.
 *
 * The view's zoom and scroll are kept on the artboard being worked on, so tools and overlays need nothing new: the
 * others are drawn where they sit relative to it, and switching artboards carries the view over.
 */
export class Project {
  name: string;
  /** Where it was opened from / last saved to as .pixl (for Save and Recent Files). */
  file: FileRef | null = null;
  /** Stable id for crash-recovery storage (a recovered file keeps the id of its copy). */
  uid = `F${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  boards: Board[];
  /** The artboard being worked on. */
  active: Doc;
  /** Called when undo or redo puts the artboards back as a step left them. */
  onLayout: () => void = () => {};

  /** The first artboard's history (as it was opened or made) becomes the file's; the others start from now. */
  constructor(name: string, boards: Board[]) {
    this.name = name;
    this.boards = boards;
    this.active = boards[0].doc;
    for (const b of boards.slice(1)) b.doc.joinHistory(this.history);
    this.history.setLayout = (l) => { this.applyLayout(l as Layout); this.onLayout(); };
  }

  get history(): History { return this.boards[0].doc.hist; }
  get docs(): Doc[] { return this.boards.map((b) => b.doc); }
  get dirty() { return this.history.index !== this.history.savedIndex; }
  has(d: Doc) { return this.boards.some((b) => b.doc === d); }
  boardOf(d: Doc): Board | null { return this.boards.find((b) => b.doc === d) ?? null; }

  /** Adds an image as an artboard, joining the shared history from as it is now. (Not an undo step: see commitLayout.) */
  add(doc: Doc, x: number, y: number) {
    doc.joinHistory(this.history);
    this.boards.push({ doc, x, y });
  }

  /** Where the artboards' shared space starts on screen (CSS px), and the zoom: from the active artboard's view. */
  get origin() {
    const d = this.active, b = this.boardOf(d)!;
    return { x: d.panX - b.x * d.zoom, y: d.panY - b.y * d.zoom, zoom: d.zoom };
  }

  /** Switches the artboard being worked on, keeping the view where it is. */
  setActive(d: Doc) {
    if (d === this.active || !this.has(d)) return;
    const o = this.origin, b = this.boardOf(d)!;
    this.active = d;
    d.zoom = o.zoom;
    d.panX = o.x + b.x * o.zoom;
    d.panY = o.y + b.y * o.zoom;
    d.fitted = true;
  }

  /** The area all the artboards cover, in their shared space. */
  bounds(): Rect {
    const x0 = Math.min(...this.boards.map((b) => b.x)), y0 = Math.min(...this.boards.map((b) => b.y));
    const x1 = Math.max(...this.boards.map((b) => b.x + b.doc.width)), y1 = Math.max(...this.boards.map((b) => b.y + b.doc.height));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** Moves an artboard (its layers go with it), keeping the view still. */
  place(b: Board, x: number, y: number) {
    if (b.doc === this.active) { b.doc.panX += (x - b.x) * b.doc.zoom; b.doc.panY += (y - b.y) * b.doc.zoom; }
    b.x = x;
    b.y = y;
  }

  layout(): Layout { return this.boards.map((b) => ({ doc: b.doc, x: b.x, y: b.y, name: b.doc.name })); }

  /** Puts the artboards as `l` has them, keeping the view still (the active one, if it moved, moves on screen). */
  applyLayout(l: Layout) {
    const o = this.origin;
    this.boards = l.map((e) => { e.doc.name = e.name; return { doc: e.doc, x: e.x, y: e.y }; });
    if (!this.has(this.active)) this.active = this.boards[0].doc;
    const d = this.active, b = this.boardOf(d)!;
    d.zoom = o.zoom;
    d.panX = o.x + b.x * o.zoom;
    d.panY = o.y + b.y * o.zoom;
  }

  /**
   * Records a change to the artboards (made since `before`, which layout() gave) as an undo step on `doc`, along with
   * whatever changed on that artboard itself (its canvas size, say).
   */
  commitLayout(label: string, before: Layout, doc: Doc = this.active) {
    doc.commit(label, [], undefined, { before, after: this.layout() });
  }
}
