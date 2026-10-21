import type { IconName } from '../ui/icons';

export interface PInfo {
  /** Document coordinates. */
  x: number;
  y: number;
  /** Workspace (CSS pixel) coordinates. */
  sx: number;
  sy: number;
  pressure: number;
  pen: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  button: number;
}

export interface Tool {
  id: string;
  name: string;
  /** Keyboard shortcut (single key). */
  key: string;
  icon: IconName;
  /** Short how-to shown in the status bar. */
  hint: string;
  cursor?(p: PInfo | null): string;
  options?(bar: HTMLElement): void;
  activate?(): void;
  deactivate?(): void;
  down?(p: PInfo): void;
  move?(p: PInfo): void;
  up?(p: PInfo): void;
  hover?(p: PInfo): void;
  keydown?(e: KeyboardEvent): boolean;
  /** Draws on-canvas guides in workspace CSS pixels. */
  overlay?(ctx: CanvasRenderingContext2D): void;
  /** Hide the system cursor (the tool draws its own). */
  ownCursor?: boolean;
}
