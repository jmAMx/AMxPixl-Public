# AMxPixl: Pixl Editor

A lightweight, non-destructive image editor. It aims to beat GIMP for everyday design and photo work and to run well on older hardware, including integrated graphics.

## Run it

```bash
npm install
npm run dev
```

The dev server opens at http://localhost:1420. `npm run build` writes a static build to `dist/`.

### Desktop app (Tauri)

Needs Rust and the Visual Studio 2022 C++ Build Tools.

```bash
npm run app
```

This runs the desktop app with live reload. `npm run package` builds `src-tauri/target/release/amxpixl.exe` and an installer in `src-tauri/target/release/bundle/nsis/`.

## What makes it different

- **Lossless transforms.** Layers keep their original pixels. You can scale, rotate, flip, resize the image or crop as many times as you like, and nothing degrades. Pixels are resampled once, on export.
- **Adjustment layers on the GPU:** Brightness/Contrast, Levels, Curves, Exposure, Hue/Saturation, HSL / Colour Mixer, Vibrance, Color Balance, Colour Grading, Photo Filter, Channel Mixer, Gradient Map, Black & White, Invert, Threshold and Posterize. All of them can be edited or removed later.
- **Effect layers on the GPU:** film grain, halation, bloom, diffusion, light leaks, fade & split tone, dust & scratches, lens distortion, chromatic aberration, vignette, CRT screen, VHS tape, compression artifacts, bit crush & dither, glitch and halftone. Sizes are in document pixels, so the preview matches the export at any zoom.
- **Compositing:** layer masks (with live density and feather), clipping masks, layer groups (Pass Through or isolated), layer styles (drop shadow, outer/inner glow, stroke, colour overlay) and Blend If.
- **Looks:** saved stacks of effect/adjustment layers, with built-in VHS, Old Film, CRT Arcade, Newsprint, Teal & Orange, Lo-fi Digital and Dreamy Mist.
- **Colour lookup:** load `.cube` LUT files as an editable adjustment layer.
- **Retouching:** clone stamp and a live healing brush, either of which can sample all layers so you can retouch on an empty layer.
- **Selections:** marquee, lasso, magic wand, Colour Range, Modify (feather, expand, contract, smooth, border), Quick Mask (Q) and Ctrl+click a layer to select its shape.
- **Opens GIMP and Photoshop files:** `.xcf` (GIMP 2.10 and 3, including GIMP 3's non-destructive filters and linear-light layer blending) and `.psd` (layers, groups, masks, clipping, blend modes). Anything that can't be carried over editably is listed when the file opens.
- **Motion:** a Timeline with frames (one per layer, or a loop), onion skinning and playback. Effect layers can animate: grain, dust and glitches re-roll, scanlines and VHS tracking roll, light leaks drift, halftone dots drift, turn, pulse or ripple. Export as GIF, animated PNG, MP4 or WebM.
- **Pixel art:** anti-aliasing can be turned off for the brush, eraser, text, shapes and selections; nearest-neighbour resampling in Image Size and Export keeps scaled pixels blocky; a pixel grid appears from 600% zoom.
- **Safe work:** autosave with crash recovery, recent files, and `.pixl` files open by double-clicking them in Explorer.
- **Lossless warp & perspective** for image layers, plus rulers, guides and snapping.
- **Vector text and shapes** stay sharp at any size until you rasterize them.
- **Fast on integrated GPUs.** Zoomed-out views draw from a cached preview pyramid, and undo data stays on the GPU.

## Layout

| Path | What's there |
| --- | --- |
| `src/core/` | Document model, undo history, compositing, brush engine, filters, GPU adjustments, selections, recovery, `.pixl` file format |
| `src/core/import/` | `.xcf` and `.psd` readers, plus GIMP filter equivalents |
| `src/tools/` | Canvas tools (move/transform, selections and magic wand, crop, brush, eraser, clone/heal, gradient, bucket, text, shapes, hand, zoom) |
| `src/ui/` | Menus, panels, dialogs, canvas view, timeline |
| `branding/` | The Pixl logo (`pixl-logo.png`) and the small-size and file-icon drawings the app icons are made from |
| `src/actions.ts` | Commands behind the menus and shortcuts |

## File format

`.pixl` = `PIXL` magic, a version, a JSON header (layers, transforms, adjustments) and one PNG per raster layer.
