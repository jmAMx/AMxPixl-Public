import { h } from './dom';
import { dialog } from './widgets';

/**
 * Help › User Guide: a short guide to Pixl, by topic. Plain text kept here, so it works offline and matches this
 * version; each topic is a few paragraphs ("**" marks a term).
 */
const TOPICS: [string, string[]][] = [
  ['Getting started', [
    'Start a **new image** (File › New, Ctrl+N) or pick a size under **Start from** on the start screen. **Open** a Pixl file, a picture, a Photoshop or GIMP file, an animated GIF or a video (File › Open, or drop it on the window). **New from Clipboard** (Ctrl+Alt+N) turns a copied screenshot into an image.',
    'The **toolbox** is on the left: press a tool\'s key to switch to it (press again to cycle tools sharing a key). Each tool\'s settings show in the **tool options**, along the top or under the tools (Edit › Preferences). The **panels** on the right (Colour, Properties, Layers, Paths, History) open and close by their titles; drag the edge between two to resize them.',
    '**Save** (Ctrl+S) keeps everything editable in a .pixl file. Pixl also keeps a crash-recovery copy of unsaved work, offered back if it ever closes unexpectedly.',
  ]],
  ['Layers', [
    'Every image is a stack of **layers**: pictures, text, shapes, groups, and **adjustment** or **effect layers** that change everything below them. Drag them in the Layers panel to reorder; the eye hides one.',
    '**Nothing is lost by transforming.** Scaling, rotating or warping a layer keeps its original pixels, so you can resize it again and again without it going soft. Pixels are only resampled when you export.',
    '**Smart objects** (Layer › Smart Object › Convert) put the selected layers inside one layer that moves, scales and takes filters as one, while what\'s inside stays editable: **Edit Contents** opens them in a tab of their own, and Save there updates the smart object.',
    '**Linked layers** (File › Place Linked) show another .pixl or image file and follow it: **Edit Original** (Layer › Linked Layer, or Properties) opens it, and saving it updates the layer, in every open file that uses it. Opening a file whose linked files changed offers to update them. The file keeps a copy, so it opens without them.',
    '**Masks** hide part of a layer without erasing it (Layer › Layer Mask): paint black to hide, white to show. A **clipping mask** (Layer › Create/Release Clipping Mask) shows a layer only where the one below has pixels. **Blend modes**, **opacity** and **Blend If** (Properties) control how a layer mixes with what\'s under it.',
  ]],
  ['Filters and effects', [
    'The **Filter** menu has blurs, sharpening, noise, distortions, stylize effects and render effects, plus the film, lens, screen and print looks. Each opens with a live preview; **Apply** changes the layer\'s pixels (inside the selection, if there is one).',
    '**Keep editable** adds the filter as an effect layer on just that layer instead, so you can change its settings or remove it later, like Photoshop\'s smart filters. Effect and adjustment layers can also be added on their own (Layer › New Effect Layer / New Adjustment Layer) to change everything below them.',
    '**Filter › Repeat** (Ctrl+F) applies the last filter again; Ctrl+Alt+F opens it to adjust first. For filters with a centre (radial and zoom blur, twirl, pinch), click the picture to place it. Save a stack of effects as a **Look** (Filter › Looks) to reuse it.',
  ]],
  ['Selections and painting', [
    'Select with the **marquee**, **lasso** or **magic wand**, by **Colour Range**, or Ctrl+click a layer\'s thumbnail to select its shape. Shift adds, Alt subtracts. **Quick Mask** (Q) lets you paint a selection.',
    'To remove something, select it loosely and use **Edit › Content-Aware Fill** (Shift+F5): Pixl fills the selection from what\'s around it, carrying on textures and lines (bricks, grass, sky). For specks, spots and scratches, the **Spot Removal** brush (J, with the Healing Brush) does the same for whatever you paint over.',
    'The **Brush**, **Eraser**, **Clone Stamp** and **Healing Brush** paint on the selected layer; [ and ] change the size, and a pen tablet\'s pressure works (Edit › Pen Tablet). Alt+click picks a colour.',
    '**Liquify** (with Blur, Sharpen and Smudge) pushes the picture around with a brush, or pinches, bloats, twirls, smooths or restores it. Like every warp it\'s lossless: the layer\'s pixels only change when you apply it (Properties › Apply, or Layer › Transform › Apply Warp).',
  ]],
  ['Artboards', [
    'One file can hold several **artboards**, each a canvas of its own size (File › New › Add artboard, or Image › Artboards). Use the **Artboard tool** (V) to move them, resize them by their edges, or draw new ones; they snap to each other.',
    'Drag a tab onto another image to make it an artboard there, or drag an artboard\'s name up to the tabs to give it a tab of its own. **Export Artboards** (File menu) saves each as its own image.',
  ]],
  ['Animation and video', [
    'Open the **Timeline** (View › Timeline) to make frames from layers, or open a GIF or video to get one layer per frame. Effects can move over the frames (Properties › Animate). **Export Animation** saves GIF, Animated PNG, MP4 or WebM.',
  ]],
  ['3D', [
    'Turn a layer into 3D with **Layer › 3D**: **Inflate**, **Extrude** or **Revolve** it. Turn it and move its light (Layer › 3D › Rotate 3D / Move Light, or with the Move tool), add textures in Properties, and use **depth effects** like depth blur and fog (Layer › Depth).',
  ]],
  ['Exporting', [
    '**File › Export Image** (Ctrl+Shift+E) saves PNG, JPEG, WebP, TIFF, BMP, a Windows icon (ICO) or a Photoshop file with its layers (PSD), at any size. **Quick Export** (Ctrl+Alt+E) repeats the last export\'s settings.',
    'Exports are resampled straight from each layer\'s originals for the sharpest result. Pick **Nearest neighbour** to keep pixel art blocky.',
  ]],
  ['Plugins', [
    '**Edit › Plugins** installs a plugin from its .pixlplugin file (or drop the file on the window), and turns plugins off or removes them. Installing shows what a plugin adds and asks first. Plugins stay when Pixl updates.',
    'This version takes **effect plugins**: new effects that appear under **Filter › Plugins** and as effect layers, working like the built-in ones. They run on the graphics card and can\'t reach your files or the internet.',
  ]],
  ['Preferences and shortcuts', [
    '**Edit › Preferences** (Ctrl+K) sets the theme, the toolbox, how often crash-recovery copies are kept, and every **keyboard shortcut**: click a command\'s keys and press new ones. **Help › Keyboard Shortcuts** (F1) lists them all.',
  ]],
];

/** One paragraph, with **terms** in bold. */
const para = (s: string) => h('p', null, ...s.split(/\*\*(.+?)\*\*/).map((part, i) => (i % 2 ? h('strong', null, part) : part)));

export function guideDialog() {
  const body = h('div', { class: 'guide-body' });
  const nav = h('nav', { class: 'guide-nav' });
  const show = (i: number) => {
    body.replaceChildren(h('h3', null, TOPICS[i][0]), ...TOPICS[i][1].map(para));
    body.scrollTop = 0;
    [...nav.children].forEach((b, j) => b.classList.toggle('on', i === j));
  };
  nav.append(...TOPICS.map(([t], i) => h('button', { type: 'button', onclick: () => show(i) }, t)));
  show(0);
  dialog({ title: 'Pixl user guide', width: 720, body: h('div', { class: 'guide' }, nav, body), buttons: [{ label: 'Close', primary: true }] });
}
