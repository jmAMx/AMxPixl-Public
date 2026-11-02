import { app, DEFAULT_METERS, type Meter } from '../app';
import * as A from '../actions';
import { pickFiles } from '../core/fileio';
import { clearRecent, recentList } from '../core/recent';
import { glfx } from '../core/glfx';
import { TAB_DRAG, view } from './canvasview';
import { colorPanel } from './colorpanel';
import { aboutDialog, animExportDialog, canvasSizeDialog, colorRangeDialog, exportDialog, filterDialog, imageSizeDialog, modifySelectionDialog, newArtboardDialog, newDocDialog, newGuideDialog, renameArtboardDialog, shortcutsDialog, updateDialog } from './dialogs';
import { h, isTyping } from './dom';
import { historyPanel } from './historypanel';
import { adjustmentMenuItems, artboardMenuItems, effectMenuItems, layersPanel, looksMenuItems, maskMenuItems } from './layerspanel';
import { FX_DEFS, FX_GROUPS } from '../core/effects';
import { tabletMenuItems } from '../tools/pressure';
import { propertiesPanel } from './properties';
import { canvasScrollbars } from './scrollbars';
import { optionsBar, toolbox, toolboxGrip } from './toolbox';
import { warpDialog } from './warpdialog';
import { timelinePanel, togglePlay } from './timeline';
import { pathsPanel, strokePathDialog } from './pathspanel';
import { closePopups, dialogOpen, icon, popupMenu, toast, type MenuItem } from './widgets';
import { isDesktop, readMeters } from '../core/platform';

// ---------- menus & shortcuts ----------

/** A menu command; `label` can be worked out when the menu opens (e.g. "Undo Brush"). */
interface Cmd { label: string | (() => string); accel?: string; alt?: string; run: () => void; enabled?: () => boolean; checked?: () => boolean; native?: boolean }
type MenuDef = { title: string; items: (Cmd | 'sep' | { label: string; sub: () => MenuItem[] })[] };

const hasDoc = () => !!app.doc;
const manyBoards = () => (app.project?.boards.length ?? 0) > 1;
const hasLayer = () => !!app.doc?.active;
const hasSel = () => !!app.doc?.selection;

const open = async () => A.openFiles(await pickFiles('any'));
const place = async () => A.placeFiles((await pickFiles('image')).map((p) => p.file));

const pasteFromMenu = async () => {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const t = it.types.find((x) => x.startsWith('image/'));
      if (t) { await A.pasteBlob(await it.getType(t)); return; }
    }
  } catch { /* permission denied: fall back to the in-app clipboard */ }
  await A.pasteBlob(null);
};

const MENUS: MenuDef[] = [
  {
    title: 'File', items: [
      { label: 'New…', accel: 'Ctrl+N', run: newDocDialog },
      { label: 'Open…', accel: 'Ctrl+O', run: open },
      { label: 'Open Recent', sub: recentMenuItems },
      { label: 'Place Image as Layer…', accel: 'Ctrl+Shift+O', run: place, enabled: hasDoc },
      'sep',
      { label: 'Save', accel: 'Ctrl+S', run: () => A.saveDoc(), enabled: hasDoc },
      { label: 'Save As…', accel: 'Ctrl+Shift+S', run: () => A.saveDoc(app.doc, true), enabled: hasDoc },
      { label: 'Export Image…', accel: 'Ctrl+Shift+E', run: () => exportDialog(), enabled: hasDoc },
      { label: 'Export Artboards…', run: () => exportDialog(true), enabled: () => (app.project?.boards.length ?? 0) > 1 },
      { label: 'Export Animation (GIF / Video)…', accel: 'Ctrl+Alt+Shift+E', run: animExportDialog, enabled: hasDoc },
      'sep',
      { label: 'Close', accel: 'Ctrl+W', run: () => A.closeDoc(), enabled: hasDoc },
    ],
  },
  {
    title: 'Edit', items: [
      // Named after the step they'd undo or redo, like "Undo Brush".
      { label: () => (app.doc?.canUndo ? `Undo ${app.doc.entries[app.doc.index - 1].label}` : 'Undo'), accel: 'Ctrl+Z', run: A.undo, enabled: () => !!app.doc?.canUndo },
      { label: () => (app.doc?.canRedo ? `Redo ${app.doc.entries[app.doc.index].label}` : 'Redo'), accel: 'Ctrl+Shift+Z', alt: 'Ctrl+Y', run: A.redo, enabled: () => !!app.doc?.canRedo },
      'sep',
      { label: 'Cut', accel: 'Ctrl+X', run: () => A.copy(false, true), enabled: hasLayer },
      { label: 'Copy', accel: 'Ctrl+C', run: () => A.copy(), enabled: hasLayer },
      { label: 'Copy Merged', accel: 'Ctrl+Shift+C', run: () => A.copy(true), enabled: hasDoc },
      { label: 'Paste', accel: 'Ctrl+V', run: pasteFromMenu, native: true },
      { label: 'Clear', accel: 'Delete', alt: 'Backspace', run: A.clearSelection, enabled: hasLayer },
      'sep',
      { label: 'Fill with Foreground', accel: 'Alt+Backspace', run: () => A.fillWith('fg'), enabled: hasLayer },
      { label: 'Fill with Background', accel: 'Ctrl+Backspace', run: () => A.fillWith('bg'), enabled: hasLayer },
      { label: 'Fill Path', run: A.fillPath, enabled: () => !!app.doc?.path },
      { label: 'Stroke Path…', run: strokePathDialog, enabled: () => !!app.doc?.path },
      'sep',
      { label: 'Free Transform', accel: 'Ctrl+T', run: () => app.setTool('move'), enabled: hasLayer },
      'sep',
      { label: 'Pen Tablet', sub: tabletMenuItems },
    ],
  },
  {
    title: 'Image', items: [
      { label: 'Image Size…', accel: 'Ctrl+Alt+I', run: imageSizeDialog, enabled: hasDoc },
      { label: 'Canvas Size…', accel: 'Ctrl+Alt+C', run: canvasSizeDialog, enabled: hasDoc },
      { label: 'Crop to Selection', run: A.cropToSelection, enabled: hasSel },
      { label: 'Crop to Content', accel: 'Ctrl+Alt+X', run: () => { void A.cropToContent(); }, enabled: hasDoc },
      'sep',
      { label: 'Rotate 90° Clockwise', run: () => A.rotateCanvas(90), enabled: hasDoc },
      { label: 'Rotate 90° Counter-clockwise', run: () => A.rotateCanvas(-90), enabled: hasDoc },
      { label: 'Rotate 180°', run: () => A.rotateCanvas(180), enabled: hasDoc },
      { label: 'Flip Canvas Horizontal', run: () => A.flipCanvas('h'), enabled: hasDoc },
      { label: 'Flip Canvas Vertical', run: () => A.flipCanvas('v'), enabled: hasDoc },
      'sep',
      { label: 'Artboards', sub: () => {
        const p = app.project, many = (p?.boards.length ?? 0) > 1;
        return [
          { label: 'New Artboard…', onClick: newArtboardDialog, disabled: !p },
          { label: 'Duplicate Artboard', onClick: A.duplicateArtboard, disabled: !p },
          { label: 'Rename Artboard…', onClick: () => renameArtboardDialog(app.doc!), disabled: !p },
          { label: 'Delete Artboard', onClick: A.deleteArtboard, disabled: !many },
          { label: 'Align', disabled: (p?.selection().length ?? 0) < 2, sub: [
            { label: 'Left Edges', onClick: () => A.alignArtboards('left') },
            { label: 'Centres Across', onClick: () => A.alignArtboards('hcenter') },
            { label: 'Right Edges', onClick: () => A.alignArtboards('right') },
            { sep: true },
            { label: 'Top Edges', onClick: () => A.alignArtboards('top') },
            { label: 'Middles', onClick: () => A.alignArtboards('vcenter') },
            { label: 'Bottom Edges', onClick: () => A.alignArtboards('bottom') },
            { sep: true },
            { label: 'Distribute Across', onClick: () => A.distributeArtboards('h'), disabled: (p?.selection().length ?? 0) < 3 },
            { label: 'Distribute Down', onClick: () => A.distributeArtboards('v'), disabled: (p?.selection().length ?? 0) < 3 },
          ] },
          { label: 'In a Row', onClick: () => A.lineUpArtboards('row', app.opts.artboard.gap), disabled: !many },
          { label: 'In a Column', onClick: () => A.lineUpArtboards('column', app.opts.artboard.gap), disabled: !many },
          { sep: true },
          ...(app.doc?.source ? [{ label: `Also Save to ${app.doc.source.name}`, checked: !!app.doc.source.linked, onClick: () => A.toggleLink(app.doc!) }] : []),
          { label: 'Open in Own Tab', onClick: () => A.artboardToTab(app.doc!), disabled: !many },
          { label: 'Copy to New Tab', onClick: () => A.artboardToTab(app.doc!, true), disabled: !p },
          { label: 'Add Open Image', sub: app.projects.filter((q) => q !== p).map((q) => ({
            label: q.name, onClick: () => { const r = p!.bounds(); A.fileIntoFile(q, p!, { x: r.x + r.w + 100, y: r.y }); view.fit(); },
          })), disabled: !p || app.projects.length < 2 },
          { sep: true },
          ...(p?.boards ?? []).map((b) => ({ label: b.doc.name, checked: b.doc === app.doc, onClick: () => app.setDoc(b.doc) })),
        ];
      } },
      { label: 'Next Artboard', accel: 'Ctrl+Alt+]', run: () => A.stepArtboard(1), enabled: manyBoards },
      { label: 'Previous Artboard', accel: 'Ctrl+Alt+[', run: () => A.stepArtboard(-1), enabled: manyBoards },
      'sep',
      { label: 'Flatten Image', run: A.flattenImage, enabled: hasDoc },
    ],
  },
  {
    title: 'Layer', items: [
      { label: 'New Layer', accel: 'Ctrl+Shift+N', run: A.newLayer, enabled: hasDoc },
      { label: 'New Group', run: A.newGroup, enabled: hasDoc },
      { label: 'New Adjustment Layer', sub: adjustmentMenuItems },
      { label: 'New Effect Layer', sub: effectMenuItems },
      { label: 'Duplicate Layer', accel: 'Ctrl+J', run: A.duplicateLayer, enabled: hasLayer },
      { label: 'Delete Layer', run: () => A.deleteLayer(), enabled: hasLayer },
      { label: 'Move to Artboard', sub: () => artboardMenuItems()[1]?.sub ?? [{ label: 'No other artboards', disabled: true }] },
      { label: 'Copy to Artboard', sub: () => artboardMenuItems()[2]?.sub ?? [{ label: 'No other artboards', disabled: true }] },
      'sep',
      { label: 'Group Layer', accel: 'Ctrl+G', run: A.groupLayer, enabled: hasLayer },
      { label: 'Ungroup', accel: 'Ctrl+Shift+G', run: A.ungroup, enabled: hasLayer },
      { label: 'Create/Release Clipping Mask', accel: 'Ctrl+Alt+G', run: A.toggleClip, enabled: hasLayer },
      { label: 'Layer Mask', sub: () => (app.doc?.active ? maskMenuItems() : [{ label: 'Select a layer first', disabled: true }]) },
      { label: 'Layer Style', sub: styleMenuItems },
      'sep',
      { label: 'Merge Down', accel: 'Ctrl+E', run: A.mergeDown, enabled: hasLayer },
      { label: 'Warp…', accel: 'Ctrl+Alt+W', run: () => { void warpDialog(); }, enabled: () => !!app.doc?.activePlaced },
      { label: '3D', sub: () => [
        ...(['inflate', 'extrude', 'revolve'] as const).map((k) => ({ label: k[0].toUpperCase() + k.slice(1), onClick: () => A.make3D(k), disabled: !app.doc?.activePlaced || !!app.doc.activeRaster?.model })),
        { sep: true },
        { label: 'Rotate 3D', onClick: () => { app.setTool('move'); app.opts.move.mode = 'rotate3d'; app.emit('tool'); }, disabled: !app.doc?.activeRaster?.model },
        { label: 'Move Light', onClick: () => { app.setTool('move'); app.opts.move.mode = 'light3d'; app.emit('tool'); }, disabled: !app.doc?.activeRaster?.model },
        { label: 'Rasterize 3D', onClick: A.rasterize3D, disabled: !app.doc?.activeRaster?.model },
      ] },
      { label: 'Depth', sub: () => [
        { label: 'New Depth Layer', onClick: A.newDepthLayer, disabled: !app.doc },
        { label: 'Depth from 3D', onClick: A.depthFrom3D, disabled: !app.doc?.activeRaster?.model },
        { label: 'Use as Depth Map', checked: !!app.doc?.activeRaster?.depth, onClick: A.toggleDepthLayer, disabled: !app.doc?.activeRaster || !!app.doc.activeRaster.model },
        { sep: true },
        { label: 'Depth Effects', sub: FX_DEFS.filter((d) => d.group === 'Depth').map((d) => ({ label: d.label, disabled: !app.doc, onClick: () => A.newEffect(d.kind) })) },
      ] },
      { label: 'Text to Outlines', run: () => { void A.textToOutlines(); }, enabled: () => app.doc?.active?.type === 'text' },
      { label: 'Fit into Shape', run: () => { void A.fitIntoShape(); }, enabled: () => !!app.doc?.activePlaced && (!!app.doc.path || (app.doc.selectedIds().length === 2)) },
      { label: 'Trim to Content', run: () => { void A.trimLayers(); }, enabled: () => app.doc?.active?.type === 'raster' || app.doc?.active?.type === 'group' || (app.doc?.selectedIds().length ?? 0) > 1 },
      { label: 'Convert Shape to Path', run: A.shapeToPath, enabled: () => app.doc?.active?.type === 'shape' },
      { label: 'Text on Path', run: A.textOnPath, enabled: () => !!app.doc?.path },
      { label: 'Rasterize / Merge Group', run: A.rasterizeLayer, enabled: () => ['text', 'shape', 'group'].includes(app.doc?.active?.type ?? '') },
      'sep',
      { label: 'Transform', sub: () => [
        { label: 'Flip Horizontal', onClick: () => A.flipLayer('h'), disabled: !app.doc?.activePlaced },
        { label: 'Flip Vertical', onClick: () => A.flipLayer('v'), disabled: !app.doc?.activePlaced },
        { label: 'Rotate 90° Clockwise', onClick: () => A.rotateLayer90(1), disabled: !app.doc?.activePlaced },
        { label: 'Rotate 90° Counter-clockwise', onClick: () => A.rotateLayer90(-1), disabled: !app.doc?.activePlaced },
        { sep: true },
        { label: 'Perspective', onClick: () => startWarp('perspective'), disabled: app.doc?.active?.type !== 'raster' },
        { label: 'Warp', onClick: () => startWarp('warp'), disabled: app.doc?.active?.type !== 'raster' },
        { label: 'Apply Warp', onClick: A.applyWarp, disabled: !app.doc?.activeRaster?.warp },
        { label: 'Remove Warp', onClick: A.removeWarp, disabled: !app.doc?.activeRaster?.warp },
        { sep: true },
        { label: 'Reset Transform', onClick: () => A.resetTransform(), disabled: !app.doc?.activePlaced },
      ] },
      { label: 'Align', sub: () => [
        { label: 'Left Edges', onClick: () => { void A.alignLayers('left'); }, disabled: !hasLayer() },
        { label: 'Horizontal Centres', onClick: () => { void A.alignLayers('hcenter'); }, disabled: !hasLayer() },
        { label: 'Right Edges', onClick: () => { void A.alignLayers('right'); }, disabled: !hasLayer() },
        { sep: true },
        { label: 'Top Edges', onClick: () => { void A.alignLayers('top'); }, disabled: !hasLayer() },
        { label: 'Vertical Centres', onClick: () => { void A.alignLayers('vcenter'); }, disabled: !hasLayer() },
        { label: 'Bottom Edges', onClick: () => { void A.alignLayers('bottom'); }, disabled: !hasLayer() },
        { sep: true },
        { label: 'Distribute Horizontally', onClick: () => { void A.distributeLayers('h'); }, disabled: (app.doc?.selectedIds().length ?? 0) < 3 },
        { label: 'Distribute Vertically', onClick: () => { void A.distributeLayers('v'); }, disabled: (app.doc?.selectedIds().length ?? 0) < 3 },
      ] },
      { label: 'Arrange', sub: () => [
        { label: 'Bring to Front', accel: 'Ctrl+Shift+]', onClick: () => A.arrange('top'), disabled: !hasLayer() },
        { label: 'Bring Forward', accel: 'Ctrl+]', onClick: () => A.arrange('up'), disabled: !hasLayer() },
        { label: 'Send Backward', accel: 'Ctrl+[', onClick: () => A.arrange('down'), disabled: !hasLayer() },
        { label: 'Send to Back', accel: 'Ctrl+Shift+[', onClick: () => A.arrange('bottom'), disabled: !hasLayer() },
      ] },
    ],
  },
  {
    title: 'Select', items: [
      { label: 'All', accel: 'Ctrl+A', run: A.selectAll, enabled: hasDoc },
      { label: 'Deselect', accel: 'Ctrl+D', run: A.deselect, enabled: hasSel },
      { label: 'Inverse', accel: 'Ctrl+Shift+I', run: A.invertSelection, enabled: hasDoc },
      'sep',
      { label: 'Colour Range…', run: colorRangeDialog, enabled: hasDoc },
      { label: 'Layer Shape', run: () => A.selectLayerShape(app.doc!.active!.id), enabled: () => !!app.doc?.active && !['adjust', 'effect'].includes(app.doc.active.type) },
      { label: 'Modify', sub: () => [
        { label: 'Feather…', accel: 'Shift+F6', onClick: () => modifySelectionDialog('feather'), disabled: !hasSel() },
        { label: 'Expand…', onClick: () => modifySelectionDialog('grow'), disabled: !hasSel() },
        { label: 'Contract…', onClick: () => modifySelectionDialog('shrink'), disabled: !hasSel() },
        { label: 'Smooth…', onClick: () => modifySelectionDialog('smooth'), disabled: !hasSel() },
        { label: 'Border…', onClick: () => modifySelectionDialog('border'), disabled: !hasSel() },
      ] },
      'sep',
      { label: 'Quick Mask', accel: 'Q', run: A.toggleQuickMask, enabled: hasDoc, checked: () => !!app.doc?.quickMask },
      'sep',
      { label: 'Path to Selection', accel: 'Ctrl+Enter', run: () => A.pathToSelection(), enabled: () => !!app.doc?.path },
      { label: 'Selection to Path', run: A.selectionToPath, enabled: hasSel },
    ],
  },
  {
    title: 'Filter', items: [
      { label: 'Looks', sub: looksMenuItems },
      { label: 'Effect Layer (editable)', sub: effectMenuItems },
      { label: 'Adjustment Layer (editable)', sub: adjustmentMenuItems },
      'sep',
      // Every effect but the depth ones, applied to the layer (or kept editable from the dialog).
      ...FX_GROUPS.filter((g) => g !== 'Depth').map((g) => ({
        label: g, sub: () => FX_DEFS.filter((d) => d.group === g).map((d) => ({ label: `${d.label}…`, disabled: !app.doc?.active, onClick: () => filterDialog(d.kind) })),
      })),
    ],
  },
  {
    title: 'View', items: [
      { label: 'Zoom In', accel: 'Ctrl+=', run: () => view.zoomStep(1), enabled: hasDoc },
      { label: 'Zoom Out', accel: 'Ctrl+-', run: () => view.zoomStep(-1), enabled: hasDoc },
      { label: 'Fit on Screen', accel: 'Ctrl+0', run: () => view.fit(), enabled: hasDoc },
      { label: 'Fit Artboard', accel: 'Ctrl+Alt+0', run: () => view.fit(true), enabled: () => (app.project?.boards.length ?? 0) > 1 },
      { label: 'Actual Pixels (100%)', accel: 'Ctrl+1', run: () => { view.setZoom(1); view.center(); }, enabled: hasDoc },
      'sep',
      { label: 'Rulers', accel: 'Ctrl+R', run: () => app.setPrefs({ rulers: !app.prefs.rulers }), checked: () => app.prefs.rulers },
      { label: 'Guides', accel: 'Ctrl+;', run: () => app.setPrefs({ guides: !app.prefs.guides }), checked: () => app.prefs.guides },
      { label: 'Snap', accel: 'Ctrl+Shift+;', run: () => app.setPrefs({ snap: !app.prefs.snap }), checked: () => app.prefs.snap },
      { label: 'Timeline', accel: 'Ctrl+Shift+T', run: () => app.setPrefs({ dock: { ...app.prefs.dock, timeline: !app.prefs.dock.timeline } }), checked: () => !!app.prefs.dock.timeline },
      { label: 'Play / Pause Animation', run: togglePlay, enabled: () => !!app.doc?.anim },
      { label: 'Onion Skin', run: () => app.setPrefs({ onion: !app.prefs.onion }), checked: () => app.prefs.onion },
      { label: 'Status Bar', sub: meterMenuItems },
      { label: 'Depth Map', accel: 'Ctrl+Alt+D', run: () => { app.showDepth = !app.showDepth; app.emit('prefs'); }, checked: () => app.showDepth, enabled: hasDoc },
      'sep',
      { label: 'Tool Names', run: () => app.setPrefs({ toolLabels: !app.prefs.toolLabels }), checked: () => app.prefs.toolLabels },
      { label: 'Pixel Grid (600% and up)', accel: "Ctrl+'", run: () => app.setPrefs({ pixelGrid: !app.prefs.pixelGrid }), checked: () => app.prefs.pixelGrid },
      { label: 'New Guide…', run: newGuideDialog, enabled: hasDoc },
      { label: 'Clear Guides', run: A.clearGuides, enabled: () => !!app.doc?.guides.length },
      'sep',
      { label: 'Dark Theme', run: () => app.setPrefs({ theme: app.prefs.theme === 'dark' ? 'light' : 'dark' }), checked: () => app.prefs.theme === 'dark' },
      { label: 'Glow Effects', run: () => app.setPrefs({ glow: !app.prefs.glow }), checked: () => app.prefs.glow },
    ],
  },
  {
    title: 'Help', items: [
      { label: 'Keyboard Shortcuts', accel: 'F1', run: showShortcuts },
      { label: 'Check for Updates…', run: () => updateDialog() },
      { label: 'About AMxPixl', run: aboutDialog },
    ],
  },
];

const extraShortcuts: [string, string][] = [
  ['V', 'Move & transform'], ['M', 'Rectangle / ellipse select'], ['L', 'Lasso'], ['W', 'Magic wand'],['Ctrl + click layer thumbnail', 'Select layer shape'], ['C', 'Crop'], ['I', 'Eyedropper'],
  ['B', 'Brush'], ['E', 'Eraser'], ['S', 'Clone stamp (Alt+click sets the source)'], ['J', 'Healing brush'], ['O', 'Dodge / burn (Alt flips)'], ['R', 'Blur / sharpen / smudge'], ['P', 'Paths (pen / freehand)'],['G', 'Gradient / paint bucket'], ['T', 'Text'], ['U', 'Shape'], ['H', 'Hand'], ['Z', 'Zoom'],
  ['X', 'Swap colours'], ['D', 'Default colours'], ['[ / ]', 'Brush size'], ['Space (hold)', 'Pan'], ['Ctrl + wheel', 'Zoom at cursor'],
  ['Alt + click (brush)', 'Pick colour'], ['Shift + drag', 'Add to selection / constrain'], ['Alt + drag', 'Subtract from selection'],
];

function showShortcuts() {
  const rows: [string, string][] = [];
  for (const m of MENUS) for (const it of m.items) if (it !== 'sep' && 'accel' in it && it.accel) rows.push([it.accel, `${m.title} › ${(typeof it.label === 'string' ? it.label : it.label().split(' ')[0]).replace('…', '')}`]);
  shortcutsDialog([...extraShortcuts, ...rows]);
}

function menuItems(def: MenuDef): MenuItem[] {
  return def.items.map((it) => {
    if (it === 'sep') return { sep: true };
    if ('sub' in it) return { label: it.label, sub: it.sub() };
    return { label: typeof it.label === 'string' ? it.label : it.label(), accel: it.accel, disabled: it.enabled ? !it.enabled() : false, checked: it.checked?.(), onClick: it.run };
  });
}

const accelMap = new Map<string, Cmd>();
for (const m of MENUS) for (const it of m.items) {
  if (it === 'sep' || 'sub' in it || it.native) continue;
  if (it.accel) accelMap.set(it.accel, it);
  if (it.alt) accelMap.set(it.alt, it);
}
const arrangeKeys: Record<string, () => void> = {
  'Ctrl+]': () => A.arrange('up'), 'Ctrl+[': () => A.arrange('down'),
  'Ctrl+Shift+]': () => A.arrange('top'), 'Ctrl+Shift+[': () => A.arrange('bottom'),
  'Ctrl+Shift+=': () => view.zoomStep(1),
  'Shift+F6': () => modifySelectionDialog('feather'),
};

const CODE_KEYS: Record<string, string> = { BracketLeft: '[', BracketRight: ']', Equal: '=', Minus: '-', NumpadAdd: '=', NumpadSubtract: '-', Backquote: '`', Semicolon: ';', Quote: "'" };

/** Switches the Move tool into perspective or warp editing for the active image layer. */
function startWarp(mode: 'perspective' | 'warp') {
  if (!A.ensureWarp(mode === 'warp' ? 'mesh' : 'perspective')) return;
  app.setTool('move');
  app.opts.move.mode = mode;
  app.emit('tool');
}

/** Layer › Layer Style: turn one on (and show its settings in Properties). */
function styleMenuItems(): MenuItem[] {
  const l = app.doc?.active;
  const ok = !!l && l.type !== 'adjust' && l.type !== 'effect';
  const add = (key: 'shadow' | 'glow' | 'innerGlow' | 'stroke' | 'overlay', label: string): MenuItem => ({
    label, disabled: !ok, checked: !!l?.styles?.[key].on,
    onClick: () => {
      A.editStyles((s) => { s[key].on = !s[key].on; }, `Layer style: ${label}`);
      if (!app.prefs.dock.properties) { app.prefs.dock.properties = true; app.setPrefs({}); }
    },
  });
  return [add('shadow', 'Drop Shadow'), add('glow', 'Outer Glow'), add('innerGlow', 'Inner Glow'), add('stroke', 'Stroke'), add('overlay', 'Colour Overlay'),
    { sep: true }, { label: 'Clear Layer Style', disabled: !l?.styles, onClick: A.clearStyles }];
}

function accelOf(e: KeyboardEvent) {
  let k = e.key;
  if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  else if (CODE_KEYS[e.code]) k = CODE_KEYS[e.code];
  else if (k.length === 1) k = k.toUpperCase();
  const mods = [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
  return [...mods, k].join('+');
}

function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented || dialogOpen() || app.busy) return;
  if (isTyping(e.target)) return;
  const accel = accelOf(e);
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape' && view.cancelDrag()) { e.preventDefault(); return; }
  // No commands mid-drag: undoing under a stroke, say, would mix the undone pixels back into it. Nor a tool's own keys
  // (an arrow nudging the layer being moved, Enter cropping mid-drag), except [ and ], which resize the brush.
  if (view.dragging) {
    if (!mod && (e.key === '[' || e.key === ']') && app.tool.keydown?.(e)) { e.preventDefault(); return; }
    if (accelMap.has(accel)) e.preventDefault();
    return;
  }
  if (!mod && app.doc && app.tool.keydown?.(e)) { e.preventDefault(); return; }
  const cmd = accelMap.get(accel);
  if (cmd) {
    e.preventDefault();
    if (!cmd.enabled || cmd.enabled()) cmd.run();
    return;
  }
  if (arrangeKeys[accel]) { e.preventDefault(); if (app.doc) arrangeKeys[accel](); return; }
  if (mod || e.altKey) return;
  const key = accel.replace('Shift+', '');
  if (key === 'X') { const f = app.fg; app.setColor('fg', app.bg); app.setColor('bg', f); return; }
  if (key === 'D') { app.setColor('fg', '#000000'); app.setColor('bg', '#ffffff'); return; }
  const group = app.tools.filter((t) => t.key === key);
  if (group.length) {
    e.preventDefault();
    const i = group.indexOf(app.tool);
    app.setTool(group[i >= 0 ? (i + 1) % group.length : 0].id);
  }
}

// ---------- layout ----------

function menubar() {
  let openIdx = -1;
  const buttons: HTMLButtonElement[] = [];
  const openMenu = (i: number) => {
    openIdx = i;
    buttons.forEach((b, j) => b.classList.toggle('open', j === i));
    const r = buttons[i].getBoundingClientRect();
    popupMenu(menuItems(MENUS[i]), r.left, r.bottom + 2, () => { if (openIdx === i) { openIdx = -1; buttons[i].classList.remove('open'); } });
  };
  MENUS.forEach((m, i) => {
    const b = h('button', { class: 'menu-btn', type: 'button' }, m.title);
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); if (openIdx === i) { closePopups(); } else openMenu(i); });
    b.addEventListener('pointerenter', () => { if (openIdx >= 0 && openIdx !== i) openMenu(i); });
    buttons.push(b);
  });
  const themeBtn = h('button', { class: 'round-btn', type: 'button', title: 'Switch light/dark theme', onclick: () => app.setPrefs({ theme: app.prefs.theme === 'dark' ? 'light' : 'dark' }) });
  const drawTheme = () => themeBtn.replaceChildren(icon(app.prefs.theme === 'dark' ? 'sun' : 'moon'));
  drawTheme();
  app.on('prefs', drawTheme);
  const undoBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Undo (Ctrl+Z)', onclick: A.undo }, icon('undo'));
  const redoBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Redo (Ctrl+Shift+Z)', onclick: A.redo }, icon('redo'));
  const syncUndo = () => {
    const d = app.doc;
    undoBtn.disabled = !d?.canUndo; redoBtn.disabled = !d?.canRedo;
    undoBtn.title = d?.canUndo ? `Undo ${d.entries[d.index - 1].label} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
    redoBtn.title = d?.canRedo ? `Redo ${d.entries[d.index].label} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)';
  };
  app.on('change', syncUndo); app.on('docs', syncUndo); syncUndo();
  return h('header', { class: 'menubar' },
    h('div', { class: 'brand', title: 'AMxPixl' },
      h('span', { class: 'wordmark' }, h('span', { class: 'px-name', role: 'img', 'aria-label': 'Pixl' }))),
    h('nav', { class: 'menus' }, ...buttons),
    h('div', { class: 'grow' }),
    undoBtn, redoBtn, themeBtn);
}

function tabs() {
  const el = h('div', { class: 'tabs', role: 'tablist' });
  const build = () => {
    el.replaceChildren(...app.projects.map((p) => {
      const d = p.active;
      const size = p.boards.length > 1 ? `${p.boards.length} artboards` : `${d.width} × ${d.height}`;
      const t = h('div', { class: 'tab' + (p === app.project ? ' on' : ''), role: 'tab', draggable: true,
        title: `${p.name} · ${size}` + (p === app.project ? '' : ' · drag onto another image to make it an artboard there (Alt copies)') },
        h('span', { class: 'tab-name' }, p.name), p.dirty ? h('span', { class: 'dirty', title: 'Unsaved changes' }, '●') : null,
        h('button', { class: 'tab-x', type: 'button', title: 'Close (Ctrl+W)', onclick: (e: MouseEvent) => { e.stopPropagation(); A.closeDoc(d); } }, icon('close')));
      // Switching waits for the click (a press may start dragging the tab onto the image shown). Not when pressing its
      // close button: switching rebuilds the tabs, and the click would then miss the button.
      t.addEventListener('pointerdown', (e) => { if (e.button === 1) { e.preventDefault(); A.closeDoc(d); } });
      t.addEventListener('click', (e) => { if (p !== app.project && !(e.target as Element).closest('.tab-x')) app.setDoc(d); });
      t.addEventListener('dragstart', (e) => { e.dataTransfer!.setData(TAB_DRAG, p.uid); e.dataTransfer!.effectAllowed = 'copyMove'; });
      return t;
    }), h('button', { class: 'tab-new', type: 'button', title: 'New image (Ctrl+N)', onclick: newDocDialog }, icon('plus')));
  };
  let lastDirty = '';
  app.on('docs', build);
  app.on('change', () => { const s = app.projects.map((p) => p.dirty).join(); if (s !== lastDirty) { lastDirty = s; build(); } });
  build();
  return el;
}

function welcome() {
  const el = h('div', { class: 'welcome' },
    h('div', { class: 'welcome-card' },
      h('img', { class: 'logo', src: 'brand/pixl-icon-256.png', alt: '' }),
      h('h1', { class: 'wordmark big' }, h('span', { class: 'px-name', role: 'img', 'aria-label': 'Pixl' }), h('span', { class: 'dim' }, ' Editor')),
      h('p', { class: 'dim' }, 'Lossless layers, GPU adjustments, everything on this PC.'),
      h('div', { class: 'welcome-actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: newDocDialog }, icon('plus'), 'New image'),
        h('button', { class: 'btn', type: 'button', onclick: open }, icon('folder'), 'Open…')),
      h('p', { class: 'dim small' }, 'or drop images here · Ctrl+V pastes from the clipboard'),
      recentGrid),
    // The AMx family tie, kept quiet.
    h('div', { class: 'amx-credit' },
      h('img', { class: 'mono for-dark', src: 'brand/monogram-dark.png', alt: '' }),
      h('img', { class: 'mono for-light', src: 'brand/monogram-light.png', alt: '' }),
      h('span', null, 'An AMx app')));
  const sync = () => { el.hidden = app.projects.length > 0; };
  app.on('docs', sync);
  app.on('recent', drawRecentGrid);
  sync();
  drawRecentGrid();
  return el;
}

const recentGrid = h('div', { class: 'recent-grid' });

function drawRecentGrid() {
  const list = recentList().slice(0, 8);
  recentGrid.hidden = !list.length;
  recentGrid.replaceChildren(
    h('div', { class: 'recent-head' }, h('span', null, 'Recent'),
      h('button', { class: 'link-btn', type: 'button', onclick: () => { clearRecent(); drawRecentGrid(); } }, 'Clear')),
    ...list.map((e) => h('button', { class: 'recent-item', type: 'button', title: e.path ?? e.name, onclick: () => A.openRecentEntry(e) },
      e.thumb ? h('img', { src: e.thumb, alt: '' }) : h('span', { class: 'recent-blank' }, icon('image')),
      h('span', { class: 'recent-name' }, e.name),
      h('span', { class: 'recent-time dim' }, ago(e.time)))));
}

function ago(t: number) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} h ago`;
  const d = Math.round(hr / 24);
  return d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : new Date(t).toLocaleDateString();
}

function recentMenuItems(): MenuItem[] {
  const list = recentList();
  if (!list.length) return [{ label: 'No recent files', disabled: true }];
  return [
    ...list.map((e) => ({ label: e.name, onClick: () => A.openRecentEntry(e) })),
    { sep: true },
    { label: 'Clear Recent Files', onClick: () => { clearRecent(); app.emit('recent'); } },
  ];
}

function statusbar() {
  const hint = h('span', { class: 'st-hint' });
  const pos = h('span', { class: 'st-pos' });
  const size = h('span', { class: 'st-size' });
  const zoom = h('input', { class: 'st-zoom', type: 'text', title: 'Zoom (type a value)', spellcheck: false, 'aria-label': 'Zoom' });
  zoom.addEventListener('change', () => { const v = parseFloat(zoom.value); if (v > 0) view.setZoom(v / 100); syncZoom(); });
  zoom.addEventListener('keydown', (e) => { if (e.key === 'Enter') zoom.blur(); });
  const zoomBox = h('label', { class: 'st-zoombox', title: 'Zoom (type a value)' }, icon('zoom'), zoom);
  // Readouts (View › Status Bar, or right-click the status bar): GPU, processor and memory use, by Pixl and the
  // whole PC. "GPU" always shows whether Pixl can use the graphics processor; the figures need the desktop app.
  const gpuNote = glfx.ok ? `Adjustments, effects and 3D run on the GPU (largest image it takes: ${glfx.maxSize} px).` : 'WebGL2 isn\'t available, so adjustment and effect layers are off.';
  const meter = (label: string, cls: string) => {
    const value = h('span', { class: 'st-meter-v' });
    return { el: h('span', { class: `st-meter ${cls}` }, label, value), value };
  };
  const gpu = meter(glfx.ok ? 'GPU' : 'GPU off', 'st-gpu'), cpu = meter('CPU', ''), mem = meter('RAM', '');
  gpu.el.classList.toggle('bad', !glfx.ok);
  const pct = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v)}%`);
  const mb = (v: number | null | undefined) => (v == null ? '–' : v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${Math.round(v)} MB`);
  let last: (number | null)[] | null = null;
  const showMeters = () => {
    const on = new Set(app.prefs.meters ?? DEFAULT_METERS);
    const r = last;
    type Fmt = (v: number | null | undefined) => string;
    const fill = (m: { el: HTMLElement; value: HTMLElement }, mine: Meter, pc: Meter, i: number, fmtMine: Fmt, fmtPc: Fmt, what: string, note = '') => {
      const parts = [on.has(mine) ? fmtMine(r?.[i]) : null, on.has(pc) ? `PC ${fmtPc(r?.[i + 1])}` : null].filter(Boolean);
      m.value.textContent = isDesktop && parts.length ? ` ${parts.join(' · ')}` : '';
      m.el.title = `${what}${isDesktop ? `\nPixl: ${fmtMine(r?.[i])} · whole PC: ${fmtPc(r?.[i + 1])}` : ''}${note ? `\n${note}` : ''}\nChoose what shows: View › Status Bar, or right-click here.`;
    };
    fill(gpu, 'gpu', 'gpuPc', 0, pct, pct, 'GPU use: the busiest part of the graphics processor, as Task Manager counts it.', gpuNote);
    fill(cpu, 'cpu', 'cpuPc', 2, pct, pct, 'Processor (CPU) use, as Task Manager counts it.');
    fill(mem, 'mem', 'memPc', 4, mb, pct, 'Memory: what Pixl has set aside for itself, and how full the PC\'s memory is.');
    cpu.el.hidden = !isDesktop || !(on.has('cpu') || on.has('cpuPc'));
    mem.el.hidden = !isDesktop || !(on.has('mem') || on.has('memPc'));
  };
  if (isDesktop) {
    // Every 1.5 s while the window is showing and something is switched on (the reading in the background stops by
    // itself once nothing asks).
    const poll = async () => {
      if (document.visibilityState !== 'visible' || !(app.prefs.meters ?? DEFAULT_METERS).length) return;
      const u = await readMeters().catch(() => null);
      if (!u) return;
      last = u;
      showMeters();
    };
    setInterval(() => { void poll(); }, 1500);
    void poll();
  }
  app.on('prefs', showMeters);
  showMeters();
  const syncZoom = () => { if (document.activeElement !== zoom) zoom.value = app.doc ? `${+(app.doc.zoom * 100).toFixed(1)}%` : ''; };
  const sync = () => {
    hint.textContent = app.tool?.hint ?? '';
    const d = app.doc;
    size.textContent = d ? `${d.width} × ${d.height} px · ${d.layers.length} layer${d.layers.length === 1 ? '' : 's'}` : '';
    zoom.disabled = !d;
    syncZoom();
  };
  view.onCursor = (p) => { pos.textContent = p && app.doc ? `${Math.floor(p.x)}, ${Math.floor(p.y)}` : ''; };
  app.on('tool', sync); app.on('docs', sync); app.on('view', syncZoom); app.on('change', sync);
  sync();
  const bar = h('footer', { class: 'statusbar' }, hint, h('span', { class: 'grow' }), pos, size, zoomBox, cpu.el, mem.el, gpu.el);
  bar.addEventListener('contextmenu', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    e.preventDefault();
    popupMenu(meterMenuItems(), e.clientX, e.clientY);
  });
  return bar;
}

/** View › Status Bar (and the status bar's right-click menu): which readouts show. */
function meterMenuItems(): MenuItem[] {
  const on = app.prefs.meters ?? DEFAULT_METERS;
  const item = (m: Meter, label: string): MenuItem => ({
    label, checked: on.includes(m),
    onClick: () => app.setPrefs({ meters: on.includes(m) ? on.filter((x) => x !== m) : [...on, m] }),
  });
  const desktopOnly = !isDesktop ? [{ label: '(The figures need the desktop app)', disabled: true }, { sep: true }] : [];
  return [
    ...desktopOnly,
    item('gpu', 'GPU use: Pixl'), item('gpuPc', 'GPU use: whole PC'), { sep: true },
    item('cpu', 'Processor (CPU): Pixl'), item('cpuPc', 'Processor (CPU): whole PC'), { sep: true },
    item('mem', 'Memory: Pixl'), item('memPc', 'Memory: whole PC'), { sep: true },
    { label: 'None', disabled: !on.length, onClick: () => app.setPrefs({ meters: [] }) },
  ];
}

function dock() {
  const panels: { id: keyof typeof app.prefs.dock & string; title: string; el: HTMLElement; grow?: boolean; closedByDefault?: boolean }[] = [
    { id: 'color', title: 'Colour', el: colorPanel() },
    { id: 'properties', title: 'Properties', el: propertiesPanel(), grow: true },
    { id: 'layers', title: 'Layers', el: layersPanel(), grow: true },
    { id: 'paths', title: 'Paths', el: pathsPanel(), closedByDefault: true },
    { id: 'history', title: 'History', el: historyPanel() },
  ];
  const el = h('aside', { class: 'dock' });
  const isOpen = (p: typeof panels[number]) => (p.closedByDefault ? app.prefs.dock[p.id] === true : app.prefs.dock[p.id] !== false);
  const build = () => {
    const heights = app.prefs.panelHeights ?? {};
    const open = panels.filter(isOpen);
    // With every stretching panel sized by hand, the last open one takes up what's left.
    const fill = open.some((p) => p.grow && !heights[p.id]) ? null : open[open.length - 1];
    const sections = panels.map((p) => {
      const openP = isOpen(p), sized = openP && !!heights[p.id];
      const s = h('section', { class: `panel panel-${p.id}` + (openP ? ' open' : '') + (p.grow ? ' grow' : '') + (sized ? ' sized' : '') + (p === fill ? ' fill' : '') },
        h('button', { class: 'panel-head', type: 'button', 'aria-expanded': String(openP), onclick: () => { app.prefs.dock[p.id] = !openP; app.setPrefs({}); } },
          h('span', { class: 'chev' }, icon('chevron')), p.title),
        h('div', { class: 'panel-body' }, p.el));
      if (sized) s.style.flexBasis = `${heights[p.id]}px`;
      return s;
    });
    // An edge to drag between each two open panels next to each other.
    const kids: HTMLElement[] = [];
    panels.forEach((p, i) => {
      kids.push(sections[i]);
      const next = panels[i + 1];
      if (next && isOpen(p) && isOpen(next)) kids.push(panelGrip(sections[i], sections[i + 1], p.id, next.id));
    });
    el.replaceChildren(...kids);
  };
  app.on('prefs', build);
  build();
  return el;
}

/** The smallest a dock panel can be dragged to: its header and a little of what's in it. */
const PANEL_MIN = 76;

/**
 * The edge between two open dock panels: dragging it makes one taller and the other shorter by as much (the others
 * stay put), and the heights are kept. It lights up on hover and while dragging; double-click puts both back to sizing
 * themselves.
 */
function panelGrip(above: HTMLElement, below: HTMLElement, a: string, b: string) {
  const grip = h('div', { class: 'dock-grip', title: 'Drag to resize these panels · double-click to size them automatically' });
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { grip.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    grip.classList.add('drag');
    const y0 = e.clientY, ha = above.getBoundingClientRect().height, hb = below.getBoundingClientRect().height;
    let na = ha, nb = hb;
    const set = (s: HTMLElement, v: number) => { s.classList.add('sized'); s.style.flexBasis = `${v}px`; s.style.flexGrow = '0'; };
    const move = (ev: PointerEvent) => {
      const dy = Math.max(PANEL_MIN - ha, Math.min(hb - PANEL_MIN, ev.clientY - y0));
      na = Math.round(ha + dy); nb = Math.round(hb - dy);
      set(above, na); set(below, nb);
    };
    const up = () => {
      grip.classList.remove('drag');
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      grip.removeEventListener('lostpointercapture', up);
      if (na !== ha || nb !== hb) app.setPrefs({ panelHeights: { ...app.prefs.panelHeights, [a]: na, [b]: nb } });
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
    grip.addEventListener('lostpointercapture', up);
  });
  grip.addEventListener('dblclick', () => {
    const rest = { ...app.prefs.panelHeights };
    delete rest[a];
    delete rest[b];
    app.setPrefs({ panelHeights: rest });
  });
  return grip;
}

export function mountShell(root: HTMLElement) {
  const ws = view.el;
  ws.append(canvasScrollbars(), welcome());
  const tools = toolbox();
  root.append(
    menubar(),
    optionsBar(),
    h('div', { class: 'main' },
      tools,
      h('section', { class: 'center' }, tabs(), ws, timelinePanel()),
      dock(),
      toolboxGrip(tools)),
    statusbar());
  window.addEventListener('keydown', onKey);
}

export { toast };
