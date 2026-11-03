# Writing a Pixl plugin

This guide walks through making plugins, from a one-file effect to a script with a panel, a tool and a file format.
[README.md](README.md) is the reference: every field of `plugin.json` and every call of the `pixl` API.

You need a text editor and, to pack plugins, [Node.js](https://nodejs.org) (or any zip tool).

## Two kinds of plugin

| | Effect plugins | Script plugins |
|---|---|---|
| Written in | GLSL (a shader) | JavaScript |
| Adds | effects, under Filter › Plugins and as effect layers | commands, a panel, tools, file formats |
| Runs | on the graphics card, every time the picture draws | in a sandboxed page, when something asks it to |
| Can reach | only the picture it's drawing | only what its permissions allow, through `pixl` |
| Permissions | none needed | listed in `plugin.json` and shown when it's installed |

One plugin can be both: effects and a script in the same `plugin.json`.

Use an **effect** when the result is a function of the picture: a colour treatment, a distortion, a pattern. Effects
stay editable, preview live, animate and export at any size, like Pixl's own. Use a **script** for anything that
does something once: changes pixels, adds layers, runs a series of Pixl's own steps, reads or writes a file format,
or reacts to clicks on the canvas.

## Your first effect

Make a folder, `my-effects`, with one file, `plugin.json`:

```json
{
  "id": "com.example.my-effects",
  "name": "My Effects",
  "version": "1.0.0",
  "pixl": 1,
  "effects": [{
    "kind": "warm",
    "label": "Warm",
    "params": [{ "key": "amount", "label": "Amount", "type": "range", "min": 0, "max": 100, "value": 50, "unit": "%" }],
    "glsl": "vec4 fx(vec2 p, vec2 d) { vec4 c = src(p); c.rgb += vec3(0.1, 0.03, -0.08) * u_amount / 100.0; return c; }"
  }]
}
```

- `id` is how Pixl knows the plugin. Installing another plugin with the same `id` updates it, so pick one that's
  yours (a reversed domain works well) and keep it.
- Each setting in `params` becomes a uniform: `amount` is `u_amount` in the shader, already declared.
- `fx(p, d)` returns the colour of one output pixel. `src(p)` is the picture under the effect at that pixel, as
  0..1 colours with straight (not premultiplied) alpha. Out-of-range results are clamped when they're drawn. To
  average several pixels, `pm()` them first and `unpm()` the result, so see-through pixels don't darken the edges.

Pack it and install it:

```bash
node pack.mjs my-effects
```

That writes `my-effects.pixlplugin` next to the folder. In Pixl, open it (File › Open, or drop it on the window).
Pixl compiles the shader first: if it has an error, installing stops and shows the error's line. Then it shows what
the plugin adds and asks before installing. Find **Warm** under Filter › Plugins.

Longer shaders are easier to keep in their own file: write `"glslFile": "warm.glsl"` instead of `"glsl"`. The
[duotone](duotone) example does both.

### Effects that look around

An effect that reads other pixels (a blur, a distortion) has to say how far it reaches, so Pixl renders enough of the
picture around each tile: `"margin": 20` (canvas pixels), `"margin": "radius"` (a setting's value), or
`"margin": "anywhere"` (it can read any pixel, like the kaleidoscope).

Sizes in effects are in canvas pixels. A preview may be drawn smaller than the image; multiply sizes by `uScale` to
get output pixels, and the preview will match the export at any zoom. To work in canvas positions instead, use
`toDoc(p)`, `fromDoc(d)` and `srcDocC(d)`. The reference lists all the helpers.

## Your first script

A script plugin names its script in `"main"`, and what the script adds:

```json
{
  "id": "com.example.flip-colours",
  "name": "Flip Colours",
  "version": "1.0.0",
  "pixl": 1,
  "permissions": [],
  "main": "main.js",
  "commands": [{ "id": "swap", "label": "Swap Foreground and Background" }]
}
```

```js
// main.js
pixl.onCommand('swap', async () => {
  const { fg, bg } = await pixl.colors();
  await pixl.setColors(bg, fg);
});
```

The command shows under Filter › Plugins. Every `pixl` call returns a promise, so use `async` and `await`.

The script runs once, when the plugin is first needed (a command, its panel, a tool or a file), and keeps running
while Pixl is open. Set things up at the top, and hand Pixl your handlers with `pixl.onCommand`, `pixl.onTool`,
`pixl.onOpen` and `pixl.onExport`.

### Permissions

A script without permissions can read the image's size and layer list, show messages and set colours. Anything else
must be asked for in `"permissions"`, and the person installing it sees each request in plain words:

- `pixels:read` to read layers' pixels and the selection.
- `pixels:write` to change pixels, add layers and change layers' settings.
- `commands` to run Pixl's own commands, such as a filter, a fill or select all.
- `files` to open and export files in the plugin's own formats.

Ask only for what you use. A call that needs a permission the plugin didn't ask for fails with an error saying so.

### Changing pixels

```js
pixl.onCommand('invert', async () => {
  const img = await pixl.image();
  const px = await pixl.pixels(img.activeLayer);        // an ImageData, with its x and y in the layer
  if (!px) return pixl.toast('Select an image layer first.');
  for (let i = 0; i < px.data.length; i += 4) for (let c = 0; c < 3; c++) px.data[i + c] = 255 - px.data[i + c];
  await pixl.setPixels(img.activeLayer, px, px.x, px.y, 'Invert'); // one undo step, called "Invert"
});
```

Pixels are the layer's own, which aren't premultiplied. A layer's pixels line up with the canvas until the layer is
moved or scaled. Only image layers have pixels: text, shapes, groups and adjustment layers don't.

### Automating Pixl's own steps

With `commands`, `pixl.run` does what the menus do, and `pixl.setLayer` changes what the layers panel shows:

```js
pixl.onCommand('soft-glow', async () => {
  await pixl.run('duplicateLayer');
  const { activeLayer } = await pixl.image();           // the copy
  await pixl.run('filter', { kind: 'gblur', settings: { radius: 12 } });
  await pixl.setLayer(activeLayer, { name: 'Glow', blend: 'screen', opacity: 0.6 });
});
```

`filter` takes any effect, Pixl's or a plugin's, with the same settings as its dialog. Each step is its own undo step.
The [layer-helpers](layer-helpers) example is a complete automation plugin.

## A panel

Add `"panel": { "title": "My Panel", "width": 280, "height": 220 }`, and the plugin gets a floating panel (Filter ›
Plugins › My Panel panel). The panel shows the script's own page, so build it with the DOM as on any web page:

```js
document.body.innerHTML = '<button id="go">Invert</button>';
document.getElementById('go').onclick = () => invert();
```

The page starts in Pixl's colours, with buttons and inputs styled to match. The colours are CSS variables
(`--bg`, `--panel`, `--text`, `--dim`, `--accent`, `--border`), so your own styles can follow the theme.
Closing the panel hides it without stopping the script. See [pixel-tools](pixel-tools).

## A tool

```json
"tools": [{ "id": "stamp", "name": "Stamp", "hint": "Click to stamp a dot" }]
```

```js
pixl.onTool('stamp', {
  down(point) { /* pressed: point.x, point.y in canvas pixels, plus pressure, shift, alt and ctrl */ },
  move(point) { /* dragged with the button down, at most once a frame */ },
  up(point) { /* let go */ },
});
```

The tool appears at the end of the toolbox, with a puzzle-piece icon. It gets the pointer and nothing else; what it
does, it does through `pixl` like any script. A tool that paints usually reads a small area with `pixl.pixels`
(its `rect` argument), changes it and writes it back. See [ppm-and-stamp](ppm-and-stamp).

## A file format

```json
"permissions": ["files"],
"formats": [{ "id": "ppm", "label": "PPM", "extensions": ["ppm", "pnm"], "open": true, "export": true }]
```

```js
pixl.onOpen('ppm', (bytes, name) => {
  // bytes: the file, as a Uint8Array
  return { width, height, layers: [{ name: 'Background', image }] }; // ImageData layers, bottom first
});
pixl.onExport('ppm', (image) => {
  // image: the flattened picture, as an ImageData the export's size
  return new Uint8Array(/* the file */);
});
```

Files with the format's extensions then open in Pixl (File › Open lists them, and they can be dropped on the window),
and the format joins the list in File › Export. The plugin sees only the
files the person chooses, never their names on disk or anything else. Pixl's own formats (PNG, JPEG, PSD and the rest)
can't be taken over. Each `onOpen` or `onExport` has a minute to answer.

## The sandbox

A script runs in a page of its own, walled off from Pixl:

- It can't reach Pixl's page or storage, your files, the network or other windows. Requests to load anything from the
  internet are blocked, so the plugin must carry everything in itself.
- The whole script is the one `main` file. Bundle anything else into it (images as `data:` URLs).
- It talks to Pixl only through `pixl`, and every call is checked against the plugin's permissions.

## Testing and fixing

- **Updating:** pack and open the plugin again. Pixl asks to update it, and its script starts afresh.
- **Errors:** an error thrown by your script while it starts, or in a command, tool or file handler, shows in Pixl as
  an error message naming your plugin. Use `pixl.toast()` to show your own messages while you work.
- **Turning it off:** Edit › Plugins turns each plugin off or removes it. A file using a missing plugin's effect still
  opens, and that layer shows the picture unchanged until the plugin is back.
- **Types:** [pixl.d.ts](pixl.d.ts) describes the whole API. Put it beside your `main.js` (or reference it with
  `/// <reference path="pixl.d.ts" />`), and editors that understand TypeScript complete and check your calls, even in
  plain JavaScript.

## Packing and sharing

A `.pixlplugin` is a zip of the plugin's folder (or of its files, with `plugin.json` at the top). `pack.mjs` makes one
with nothing to install; any zip tool works too, renamed to `.pixlplugin`. A plugin with only effects written inline
can also be shared as the bare `plugin.json`.

Set `"pixl": 1`: the plugin API version you wrote for. A later Pixl that changes the API will still know what your
plugin expects, and an older Pixl will refuse a plugin written for a newer API instead of running it wrongly.

## Limits

- `id`: up to 64 letters, digits, dots and dashes. `name`: up to 60 characters.
- Up to 64 effects. Effect `kind`s and command, tool and format `id`s: lowercase letters, digits and dashes.
- The script is at most 512 KB.
- Format extensions: up to 10 lowercase letters and digits.

## The examples

| Folder | Shows |
|---|---|
| [duotone](duotone) | effects with colour and range settings, a shader in its own file, an effect that reads anywhere |
| [pixel-tools](pixel-tools) | commands that read and write pixels and the selection, a new layer, a panel |
| [layer-helpers](layer-helpers) | automation: Pixl's own commands in a row, and layer settings |
| [ppm-and-stamp](ppm-and-stamp) | a file format (open and export) and a tool |
