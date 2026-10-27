# Changelog

Each version's section becomes its release notes (`scripts/release.ps1` copies it to the download page).

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

## 0.4.0

- Magic Wand, Colour Range, Select › Modify, Quick Mask, select layer shape.
- Opens GIMP (.xcf) and Photoshop (.psd) files.
- Autosave with crash recovery, recent files, .pixl file association, update check.
- Pixel-art options: anti-alias toggles, nearest-neighbour resampling, pixel grid.
