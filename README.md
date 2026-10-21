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
- **Compositing:** layer masks (with live density and feather), clipping masks, and layer groups (Pass Through or isolated).
- **Vector text and shapes** stay sharp at any size until you rasterize them.
- **Fast on integrated GPUs.** Zoomed-out views draw from a cached preview pyramid, and undo data stays on the GPU.

## Layout

| Path | What's there |
| --- | --- |
| `src/core/` | Document model, undo history, compositing, brush engine, filters, GPU adjustments, `.pixl` file format |
| `src/tools/` | Canvas tools (move/transform, selections, crop, brush, eraser, gradient, bucket, text, shapes, hand, zoom) |
| `src/ui/` | Menus, panels, dialogs, canvas view |
| `src/actions.ts` | Commands behind the menus and shortcuts |

## File format

`.pixl` = `PIXL` magic, a version, a JSON header (layers, transforms, adjustments) and one PNG per raster layer.
