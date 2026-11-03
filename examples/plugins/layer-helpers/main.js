// An example automation plugin: each command is a few of Pixl's own steps in a row (pixl.run), plus layer settings
// (pixl.setLayer). Every step is its own undo step, just as if you'd done it by hand.

// Soft Glow: a blurred copy of the selected layer on top of it, lightening it softly.
pixl.onCommand('soft-glow', async () => {
  await pixl.run('duplicateLayer'); // the copy is selected afterwards
  const { activeLayer } = await pixl.image();
  await pixl.run('filter', { kind: 'gblur', settings: { radius: 12 } });
  await pixl.setLayer(activeLayer, { name: 'Glow', blend: 'screen', opacity: 0.6 });
});

// Hides every layer but the selected one (groups stay as they are, so the layer can still show inside its group).
pixl.onCommand('solo', async () => {
  const { layers, activeLayer } = await pixl.image();
  for (const l of layers) if (l.type !== 'group') await pixl.setLayer(l.id, { visible: l.id === activeLayer });
});

pixl.onCommand('show-all', async () => {
  const { layers } = await pixl.image();
  for (const l of layers) if (!l.visible) await pixl.setLayer(l.id, { visible: true });
});
