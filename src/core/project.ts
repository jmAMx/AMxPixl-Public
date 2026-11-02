import { History, type Doc } from './document';
import type { FileRef } from './fileio';

/** An artboard: an image, and where its top-left corner sits among the file's other artboards. */
export interface Board { doc: Doc; x: number; y: number }

/**
 * A file, open in one tab: one or more artboards, each its own image (a Doc, with its own size, layers, selection and
 * pixels), so everything that works on an image works on an artboard as it is. The artboards share one undo history,
 * in the order the steps were made, and are saved, recovered and closed together. A plain image is a file with one.
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

  /** The first artboard's history (as it was opened or made) becomes the file's; the others start from now. */
  constructor(name: string, boards: Board[]) {
    this.name = name;
    this.boards = boards;
    this.active = boards[0].doc;
    for (const b of boards.slice(1)) b.doc.joinHistory(this.history);
  }

  get history(): History { return this.boards[0].doc.hist; }
  get docs(): Doc[] { return this.boards.map((b) => b.doc); }
  get dirty() { return this.history.index !== this.history.savedIndex; }
  has(d: Doc) { return this.boards.some((b) => b.doc === d); }

  /** Adds an image as an artboard, joining the shared history from as it is now. (Not an undo step yet.) */
  add(doc: Doc, x: number, y: number) {
    doc.joinHistory(this.history);
    this.boards.push({ doc, x, y });
  }
}
