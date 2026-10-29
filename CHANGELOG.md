# Changelog

Each version's section becomes its release notes (`scripts/release.ps1` copies it to the download page).

## 0.8.1

- **GPU use in the status bar**: "GPU" now shows how busy the graphics processor is with Pixl's work, as Task Manager counts it, and hovering it also gives the whole PC's figure. It updates every 1.5 seconds while Pixl is on screen, and reading it costs about a millisecond each time.
- The zoom percentage in the status bar has a magnifier icon, so it isn't mistaken for the GPU figure next to it.
- Fixed: an Extrude with a Bevel had a gap between its sides and the front and back, most visible at the corners when turned. The sides now rise to meet the bevelled face, so the object is solid at any bevel.

## 0.8.0

3D & Depth.

- **3D layers: Inflate** (Layer › 3D › Inflate): turns text, a shape or an image into a lit 3D object, puffed out like a balloon or a pillow, with its own picture on the front. It stays editable: Depth and Roundness, a turn on three axes, a light (direction, height, strength, ambient), and a Matte, Plastic or Metal finish in its own colours or a solid colour.
- **Extrude** (Layer › 3D › Extrude): gives text, a shape or an image straight sides and depth, like a cookie cutter, with Thickness and a rounded **Bevel** on the front edge. The sides take their colour from the picture's edge.
- **Revolve** (Layer › 3D › Revolve): spins the silhouette around an upright axis, like a lathe, for vases, bottles, rings and tubes. Spin it around the picture's middle (draw the whole object) or its left edge (draw half of it). Gaps beside the axis make it hollow.
- Switch a 3D layer between Inflate, Extrude and Revolve at any time in Properties › 3D.
- **Rotate 3D** (Move tool): drag on the canvas to turn a 3D layer, Shift+drag to spin it, and **Face front** to straighten it. The light stays put, so it shades as it turns.
- **Textures on 3D objects** (Properties › 3D › Texture): lay an image over the surface, such as wood, stone, fabric or a label. Pick an image file, or another layer: a copy is taken and the layer is hidden. It fits the front of Inflate and Extrude, runs around Extrude's sides, and wraps once around a revolved shape like a bottle label, keeping its proportions. Set its size, position, turn and strength. **Cover** shows the texture's own colours; **Multiply** keeps the colours underneath and darkens them by it. **Repeat** tiles small patterns. **Bump** makes its light parts stand out from the surface. On Extrude it can go all over, only on the front and back, or only on the sides.
- **Rasterize 3D** bakes a 3D layer into ordinary pixels you can paint on. 3D layers save in .pixl files and come back exactly as they were.
- **Depth maps** (Layer › Depth): a depth layer holds greys for how far things are (white near, black far). It isn't part of the picture: all depth layers together make the image's depth map. **New Depth Layer** starts one as level ground to paint over with any brush, fill or gradient. **Depth from 3D** makes one from a 3D layer as it's turned. **Use as Depth Map** turns any image layer into one, such as a depth map made in another app. While a depth layer is selected the canvas shows the depth map, and View › Depth Map (Ctrl+Alt+D) shows it any time.
- **Depth effects** (Layer › Depth › Depth Effects, or New Effect Layer › Depth):
  - **Depth Blur**: a camera's shallow focus. Pick the focus distance and how much stays sharp. Nearer and farther things blur more the further they are from it, with brighter highlights if you like. "Show what blurs" tints the blurred parts red while you set it up.
  - **Fog & Haze**: fades distant things into a colour, from where it starts to where it's thickest.
  - **Relief Lighting**: lights the depth map as a surface from one side, for embossed shading.
  - **Parallax (3D Photo)**: shifts near and far things against each other as if the camera moved. With Animate on, it sways or circles across the Timeline's frames and in GIF and video exports.

## 0.7.0

Type & Warp.

- **Warp presets** (Layer › Warp…, Ctrl+Alt+W, or Warp… in the Text tool and Properties): Arc, Arc Lower, Arc Upper, Arch, Bulge, Flag, Wave, Fish, Rise, Fisheye, Inflate, Squeeze and Twist. Each has Bend, horizontal and vertical distortion, and a vertical option, all previewed live. Text and shapes stay editable, and the warp refits when you change the words. Image layers get an editable mesh warp you can fine-tune with Move › Warp.
- **Fit into Shape** (Layer menu, or Fit layer into in the Paths panel): bends text, a shape or an image to fill a closed path, or a shape layer selected along with it (the upper shape is the container and gets hidden), like Illustrator's envelope "Make with Top Object". Text fills the shape edge to edge with its letters and stays editable; images get an editable mesh warp.
- **Text to Outlines** (Layer menu, or To outlines in the Text tool): the letters, read from the font file, become an outline shape you can reshape point by point with the Paths tool. Colour, layer styles, mask, transform and warp carry over, and the text layer is kept (hidden) in case you want to retype it. Fonts stored in Windows font collections (.ttc, e.g. Cambria Regular) can't be outlined yet, and nor can text on a path.
- **Undo and Redo say what they'll do**: the Edit menu and the arrow buttons' tooltips read, for example, "Undo Warp" or "Redo Brush".
- Fixed: typing a value in Properties and pressing Enter recorded the change twice in the history.
- Fixed: new groups and shapes were numbered from one shared counter ("Group 4" for the first group).

## 0.6.7

- **Open source**: Pixl is now under the MIT licence (see LICENSE and Help › About).
- **Radial symmetry**: Mirror › Radial turns every stroke into 2–16 copies around a centre, like spokes of a wheel.
- **Move the symmetry centre**: drag the round handle where the mirror lines cross. It snaps to guides and to the canvas middle and edges, and **Centre** puts it back in the middle.
- **Properties for several layers**: with more than one layer (or a group) selected, X, Y, W and H show the box around all of them. Typing a position moves them all, and a size resizes them together.
- **Trim to Content** (Layer menu, or right-click a layer): shrinks image layers' stored pixels to the area that has something in it. Nothing changes on the canvas; files get smaller and use less memory.

## 0.6.6

- **Move a whole group**: select a group and the Move tool moves, scales and turns everything inside it together.
- **Align and distribute** (Move tool options, or Layer › Align): line selected layers up by their edges or centres, or space three or more evenly. A single layer lines up with the canvas. Groups count as one item, and it lines up what you see, not the layer's full area.
- **Several selected layers at once**: Group (Ctrl+G), Duplicate (Ctrl+J), Delete, and the eye (show/hide) work on every selected layer.
- **Symmetry painting**: a Mirror option for the Brush, Eraser, Dodge, Burn, Blur and Sharpen tools. It mirrors strokes left/right, top/bottom or four ways across the middle of the canvas, shown by a dashed line.
- Fixed: Lens Distortion (with transparent edges) cut off glows and anything else just past the canvas edge, leaving a hard line, most noticeably after Crop to Content. Effects that reach past the edge now see what's really there.
- The new AMx logo in the "An AMx app" credit, in dark and light versions.
- A tidier top bar: the version number moved to the window's title bar only, and "Pixl" lines up with the tool icons below it, with the same space between it and the menus as from the window edge. The toolbox scrolls without a scrollbar, so the icons stay put in short windows.

## 0.6.5

- **Crop to Content** (Image menu, Ctrl+Alt+X, or the button in Canvas Size) trims the empty space around the image. Empty means transparent, or, on an opaque image, the plain colour of its top-left corner.
- **Your settings survive updates**: saved looks, recent files, preferences, tool options, colours, brush presets and custom brush tips are also kept in a settings file in your app-data folder. Anything the app's web storage loses is put back from it at startup.
- Fixed: with the tool options in the sidebar, an empty band appeared under the window.

## 0.6.4

- **Bounding boxes** that fit what's on the layer. The Move tool's box hugs the visible pixels instead of the whole layer, so a small shape on a big layer gets a small box. Its handles scale it, dragging just outside a corner turns it, and X, Y, W and H in Properties give its real size and place on the canvas.
- **Box setting** in the Move tool: **Content** (the visible pixels), **Layer** (the whole layer) or **Custom**, a box you size yourself with **Edit box**. A custom box is saved with the layer, and **Fit to content** and **Fit to layer** reset it.
- **Several layers at once**: Ctrl+click layers in the Layers panel (Shift+click for a run of them), or Ctrl+Shift+click them on the canvas. They share one box and move, scale, turn and nudge together.
- The top bar starts with the "Pixl" name, without the small logo, and the welcome screen shows the P icon.

## 0.6.3

- **Tool groups**: right-click a tool to start a group or add it to one. A group takes one slot in the toolbox and shows the tool you used last; right-click or press and hold it to pick another. "Group Tools by Shortcut Key" sets up the usual groups in one go.
- **Tool options in the sidebar**: the ⋯ button at the right of the options bar moves them under the tools (and back). The toolbox widens to fit them and spreads the tools into a grid.
- New Dodge (sun) and Burn (flame) icons, so they no longer look like Zoom and Hand.
- The "Pixl" name is laid out like the logo, with a small IXL under the P.
- The title bar shows the version, e.g. "AMxPixl 0.6.3".

## 0.6.2

- **Toolbox**: drag its right edge wider to lay the tools out in a grid (double-click the edge for one column). Turn on tool names under the icons with View › Tool Names or by right-clicking the toolbox.
- **Canvas scrollbars** along the bottom and right when the image runs past the window.
- **Menus stay on screen**: right-click menus and submenus open to the left or upwards when there's no room, and very long menus scroll.
- The "Pixl" name at the top is set in the logo's typeface.
- Ready for the public repository: updates are checked against its Releases page, the README lists system requirements, and the notes describe hardware generally rather than naming particular parts.

## 0.6.1

Faster and smoother, measured on older hardware (a 4-core desktop processor with integrated graphics):

- **Opening GIMP files** happens in the background, so the window stays responsive. A file with many filters used to freeze it for over 5 seconds.
- **GIF export** is about 10× faster (24 frames at 1500×1000: 123 s → 12 s). Frames are colour-reduced and encoded on background threads, so the app no longer freezes for seconds at a time.
- **Painting** is about 6× faster per brush movement on large images. The canvas redraws only the area that changed, plus room for effects like shadows and halftone that spread out.
- **Magic wand** with "Select similar" runs in the background.
- The **Pen** is now the **Paths** tool (P) with two modes, like Illustrator's Pen and Pencil. In **Pen** mode you place anchor points. In **Freehand** mode you drag to draw, and the line is smoothed into editable points. Drawing back to the start closes the path. A Smoothness slider sets how many points it keeps.
- New eyedropper icon.

## 0.6.0

- **Pen tool (P)** and a **Paths** panel: Bézier paths you can edit (drag points and handles, corner/smooth, add and delete points). Fill or stroke a path (with the Brush or a plain line), turn it into a selection (Ctrl+Enter) or trace a selection into a path.
- **Text on a path**, with a Start slider to slide it along the curve.
- **Polygon and star shapes**, and Convert Shape to Path.
- **Retouch tools**: Dodge and Burn (O; shadows, midtones or highlights), Blur, Sharpen and Smudge (R).
- **Brushes**: textured tips (chalk, spray, charcoal, grain, splatter, square, or your own from an image), spacing, angle jitter and scatter, and saved brush presets.
- GIMP files: hue-saturation now matches GIMP more closely.

## 0.5.2

- Sharper icons: the app and .pixl file icons are shrunk in steps with high-quality filtering (no more jagged edges), and the file icon's logo sits on a dark tile so it reads at small sizes. `npm run icons` rebuilds them from `branding/`.
- Check for Updates looks at this repository's Releases page.

## 0.5.1

- Pixl's icon: the full logo at large sizes, the colour-bar P icon at small sizes (taskbar, title bar, file icons).
- New effect layer: **Video Degradation** (CRT & VHS), with GIMP's nine RGB patterns, cell size, additive and rotated options. It can animate (the pattern rolls).

## 0.5.0

- **Timeline** (View › Timeline): frames from layers or an effects loop, per-frame layer visibility, frame lengths, drag to reorder, playback, onion skin.
- **Animated effects**: grain, dust, glitch and VHS noise re-roll; scanlines and VHS tracking roll; light leaks drift; halftone dots drift, turn, pulse or ripple.
- **Export Animation**: GIF, animated PNG, MP4 and WebM.
- Healing brush matches its surroundings on wide strokes and when sampling all layers.
- GIMP files: bevel filter, exact video-degradation patterns.

## 0.4.6

- New app icon, embedded correctly in the program.

## 0.4.5

- Pixl's own logo, in light and dark versions with hand-drawn 16 and 32 px sizes. The in-app logo follows the light/dark theme, and the AMx tie is a small "An AMx app" credit on the welcome screen and in About.
- .pixl files get their own document icon in Explorer.
- 0.4.5.1: the logo stands on its own without a background tile, with a thin outline so it stays visible on dark taskbars.

## 0.4.0

- Magic Wand, Colour Range, Select › Modify, Quick Mask, select layer shape.
- Opens GIMP (.xcf) and Photoshop (.psd) files.
- Autosave with crash recovery, recent files, .pixl file association, update check.
- Pixel-art options: anti-alias toggles, nearest-neighbour resampling, pixel grid.

## 0.3.0

- Layer styles: drop shadow, outer and inner glow, stroke (outside, centre or inside) and colour overlay, editable and drawn on the GPU.
- Blend If: fade a layer by its own brightness or the brightness underneath.
- Colour Lookup adjustment loads .cube LUT files (3D and 1D).
- Clone Stamp (S) and Healing Brush (J) with aligned sampling.
- Lossless perspective and mesh warp for image layers.
- Rulers, guides (drag them from the rulers) and snapping to guides, the canvas and layers.
- Looks: seven built-in effect stacks, plus saving your own.
- A half-resolution preview while dragging when full quality is too slow for the computer.
- Fixes: Ctrl+G and other shortcuts were swallowed in the desktop app; the first frame after adding a LUT could look wrong.

## 0.2.0

- Layer masks with live density and feather. Brushes, gradients, fill and filters paint on the mask when it's selected.
- Clipping masks and layer groups (Pass Through or isolated).
- GPU effect layers: film grain, halation, bloom, diffusion, light leak, fade & split tone, dust & scratches, lens distortion, chromatic aberration, vignette, CRT screen, VHS tape, compression artifacts, bit crush & dither, glitch and halftone.
- New adjustments: HSL / Colour Mixer, Colour Grading, Gradient Map, Channel Mixer and Photo Filter.
- The Layers panel shows the group tree and mask thumbnails, and has a right-click menu.

## 0.1.0

The first version: a lightweight, non-destructive image editor meant to replace GIMP and run well on older hardware.

- Lossless layer transforms, image size, crop, rotate and flip.
- GPU adjustment layers (levels, curves, hue/saturation, exposure and more).
- Brush, eraser, gradient, paint bucket, selections, text and vector shapes.
- Filters with live preview, the .pixl project format, and PNG, JPEG and WebP export.
- A cached preview pyramid and GPU-side undo keep large images quick.
- Windows desktop app with an installer.
