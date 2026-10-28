# AMxPixl: Pixl Editor

A lightweight, non-destructive image editor. It aims to beat GIMP for everyday design and photo work and to run well on older hardware, including integrated graphics.

## System requirements

| | Minimum | Recommended |
| --- | --- | --- |
| OS | Windows 10 or 11, 64-bit | |
| Processor | 2 cores | 4 cores |
| Memory | 4 GB | 8 GB or more for large images |
| Graphics | WebGL2 support (most integrated and dedicated GPUs from about 2013 on) | |
| Disk | About 5 MB | |

Pixl uses Microsoft Edge WebView2, which comes with Windows 11 and recent Windows 10 updates; if it's missing, the installer downloads it. Without WebGL2 everything works except adjustment and effect layers.

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

### Releasing

1. Bump `version` in `package.json` and add a `## <version>` section to `CHANGELOG.md`.
2. `npm run package`
3. Commit, then `npm run release`. It copies the new commits onto the `public-main` branch (`npm run sync-public` does just that step) and stops if one names specific hardware. Then it tags the version, pushes `public-main` and its version tags to this repository, and publishes the installer on the [Releases](https://github.com/jmAMx/AMxPixl-public/releases) page. Add `-- -Draft` to review it on GitHub before it goes live. The app's Help › Check for Updates reads that page.

Every version from 0.1.0 on has a `v…` tag, including ones that weren't published as releases; `CHANGELOG.md` has the notes for each.

One-time setup: `winget install GitHub.cli`, then `gh auth login`, and a `public` remote pointing at this repository.

## What makes it different

- **Lossless transforms.** Layers keep their original pixels. You can scale, rotate, flip, resize the image or crop as many times as you like, and nothing degrades. Pixels are resampled once, on export.
- **Adjustment layers on the GPU:** Brightness/Contrast, Levels, Curves, Exposure, Hue/Saturation, HSL / Colour Mixer, Vibrance, Color Balance, Colour Grading, Photo Filter, Channel Mixer, Gradient Map, Black & White, Invert, Threshold and Posterize. All of them can be edited or removed later.
- **Effect layers on the GPU:** film grain, halation, bloom, diffusion, light leaks, fade & split tone, dust & scratches, lens distortion, chromatic aberration, vignette, CRT screen, VHS tape, compression artifacts, bit crush & dither, glitch and halftone. Sizes are in document pixels, so the preview matches the export at any zoom.
- **Compositing:** layer masks (with live density and feather), clipping masks, layer groups (Pass Through or isolated), layer styles (drop shadow, outer/inner glow, stroke, colour overlay) and Blend If.
- **Looks:** saved stacks of effect/adjustment layers, with built-in VHS, Old Film, CRT Arcade, Newsprint, Teal & Orange, Lo-fi Digital and Dreamy Mist.
- **Colour lookup:** load `.cube` LUT files as an editable adjustment layer.
- **Retouching:** clone stamp and a live healing brush (either can sample all layers, so you can retouch on an empty layer), dodge and burn, blur, sharpen and smudge.
- **Brushes:** textured tips (built-in or from your own image), spacing, angle jitter, scatter and saved presets.
- **Paths:** a Paths tool for Bézier paths (place points like a pen, or draw freehand and it's smoothed into points); fill, stroke, path ↔ selection, text on a path, polygon and star shapes, shape to path.
- **Selections:** marquee, lasso, magic wand, Colour Range, Modify (feather, expand, contract, smooth, border), Quick Mask (Q) and Ctrl+click a layer to select its shape.
- **Opens GIMP and Photoshop files:** `.xcf` (GIMP 2.10 and 3, including GIMP 3's non-destructive filters and linear-light layer blending) and `.psd` (layers, groups, masks, clipping, blend modes). Anything that can't be carried over editably is listed when the file opens.
- **Motion:** a Timeline with frames (one per layer, or a loop), onion skinning and playback. Effect layers can animate: grain, dust and glitches re-roll, scanlines and VHS tracking roll, light leaks drift, halftone dots drift, turn, pulse or ripple. Export as GIF, animated PNG, MP4 or WebM.
- **Pixel art:** anti-aliasing can be turned off for the brush, eraser, text, shapes and selections; nearest-neighbour resampling in Image Size and Export keeps scaled pixels blocky; a pixel grid appears from 600% zoom.
- **Safe work:** autosave with crash recovery, recent files, and `.pixl` files open by double-clicking them in Explorer.
- **Bounding boxes** that fit the visible pixels (or the whole layer, or a box you set), with several layers transformed together.
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
| `branding/` | The Pixl logo (`pixl-logo.png`, large sizes) and icon (`pixl-icon.png`, 16–32 px), plus the rendered `.pixl` file icon. The "Pixl" wordmark in the app is outlines of the Spotnik typeface (`public/brand/pixl-wordmark.svg`); the font itself isn't included |
| `src/actions.ts` | Commands behind the menus and shortcuts |

## File format

`.pixl` = `PIXL` magic, a version, a JSON header (layers, transforms, adjustments) and one PNG per raster layer.

## Licence

[MIT](LICENSE) © 2026 AutoMatrix Solutions LLC.

The Pixl and AMx names and logos are AutoMatrix Solutions LLC's brand, not part of the MIT licence: forks should use their own. Bundled third-party parts keep their own licences: the Rajdhani font (SIL Open Font License) and the libraries listed in `package.json` and `src-tauri/Cargo.toml`.
