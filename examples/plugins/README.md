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

The `duotone` folder here is a working example: zip what's inside it and rename the zip to `.pixlplugin`.
