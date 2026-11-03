# Pixl plugins

A plugin is a `.pixlplugin` file: a zip of a folder holding `plugin.json` (and any files it names), or a
`plugin.json` on its own. Install it from **Edit › Plugins**, or drop it on the Pixl window. Plugins are kept per
user and survive updates.

This version of Pixl takes **effect plugins**: GPU shaders with settings. Each becomes an effect like the built-in
ones, under **Filter › Plugins** (applied to a layer, or kept editable) and **Layer › New Effect Layer › Plugins**.
A shader runs on the graphics card and can't reach files or the internet, so effect plugins need no permissions.

## plugin.json

```json
{
  "id": "com.example.my-effects",
  "name": "My Effects",
  "version": "1.0.0",
  "author": "Me",
  "description": "What it adds.",
  "pixl": 1,
  "effects": [{ "kind": "duotone", "label": "Duotone", "params": [], "glsl": "vec4 fx(vec2 p, vec2 d) { return src(p); }" }]
}
```

- `id`: letters, digits, dots and dashes; installing a plugin with the same id updates it.
- `pixl`: the plugin API version it was written for (1).
- Each effect has a `kind` (lowercase letters, digits, dashes), a `label`, its `params`, and its shader as `glsl` or
  as `glslFile` (a file in the plugin).
- Optional: `margin` (how far, in canvas pixels, the shader reads around each pixel: a number, a setting's `key`, or
  `"anywhere"`), `seeded` (it uses the random seed: a New variation button, re-rolled in animations) and `moves` (it
  moves with `uTime` in animations).

## Settings (`params`)

Each becomes a uniform named `u_<key>`, declared for you:

| type | fields | in the shader |
|---|---|---|
| `range` | `min`, `max`, `step`, `value`, `unit` | `float` |
| `bool` | `value` | `float`, 0 or 1 |
| `color` | `value` (`"#rrggbb"`) | `vec3`, 0..1 |
| `select` | `options` (`["value", "Label"]` pairs), `value` | `float`, the option's index |

## The shader

Write `vec4 fx(vec2 p, vec2 d)`, returning the colour at output pixel `p` (`d` is the same point in canvas pixels).
Sizes are in canvas pixels; `uScale` turns them into output pixels, so previews match exports at any zoom. Pixl gives
every effect:

- `src(p)` (the picture under the effect), `srcC(p)` (kept inside the canvas), `srcDocC(d)` (by canvas position)
- `docSize()`, `toDoc(p)`, `fromDoc(d)`, `uScale`, `uTime`, `uSeed`
- `lum(rgb)`, `hash(vec2)`, `vnoise(vec2)`, `fbm(vec2, octaves)`, `pm()`/`unpm()` (averaging see-through colours)

The `duotone` folder here is a working example: zip it and rename the zip to `.pixlplugin`.

## Script plugins

A plugin can also have a script (`"main": "main.js"`): **commands** (listed under Filter › Plugins) and a **panel** (a
floating window showing the script's own page). The script runs in a sandbox: its own page, cut off from Pixl, your
files, the network and new windows. It works only through `pixl`, and only as far as its `permissions` allow (shown,
in plain words, when it's installed):

| permission | lets it |
|---|---|
| `pixels:read` | read layers' pixels and the selection |
| `pixels:write` | change layers and add new ones (each change is a step you can undo) |
| `commands` | run Pixl's own commands |

```json
"permissions": ["pixels:read", "pixels:write"],
"main": "main.js",
"commands": [{ "id": "invert", "label": "Invert" }],
"panel": { "title": "My Panel", "width": 280, "height": 220 }
```

The `pixl` API (every call returns a promise):

- `pixl.onCommand(id, async () => { … })`: what a command does.
- `pixl.image()`: the open image: `name`, `width`, `height`, `activeLayer`, `selection` (true/false) and `layers`
  (`id`, `name`, `type`, `visible`, `opacity`, `blend`, bottom to top).
- `pixl.pixels(layerId, rect?)`: an image layer's own pixels as an `ImageData` (with its `x`, `y`). Needs `pixels:read`.
- `pixl.selection()`: the selection as an `ImageData` the image's size (alpha: how selected), or null. Needs `pixels:read`.
- `pixl.setPixels(layerId, imageData, x, y, label)`: puts pixels back, as one undo step. Needs `pixels:write`.
- `pixl.addLayer(name, imageData?)`: a new image layer; returns its id. Needs `pixels:write`.
- `pixl.run(command, args)`: one of Pixl's commands. Needs `commands`. They are `newLayer`, `newGroup`,
  `duplicateLayer`, `deleteLayer`, `mergeDown`, `flatten`, `selectAll`, `deselect`, `invertSelection`,
  `fill` (`{ with: 'fg' | 'bg' }`), `undo`, `redo`, `selectLayer` (`{ id }`), and `filter`
  (`{ kind, settings }`, any effect: `{ kind: 'gblur', settings: { radius: 4 } }`).
- `pixl.toast(text)`, `pixl.colors()`, `pixl.setColors(fg, bg)`.

The `pixel-tools` folder is a working example of a script plugin with commands and a panel.
