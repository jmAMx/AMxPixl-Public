import { app } from '../app';
import { pickFiles } from '../core/fileio';
import { fxEngine } from '../core/fx';
import { installedPlugins, installPlugin, PERMISSIONS, pluginFx, readPlugin, removePlugin, setPluginEnabled, type InstalledPlugin, type PluginManifest } from '../core/plugins';
import { closeFrame } from './pluginhost';
import { h } from './dom';
import { ask, checkbox, dialog, toast } from './widgets';

/** After plugins change: open images draw again (an effect that came or went) and the panels catch up. */
function refresh() { for (const p of app.projects) for (const d of p.docs) d.touch('meta'); }

/**
 * Installs a .pixlplugin (from Edit › Plugins, opening it, or dropping it on the window): reads and checks it, tries
 * its shaders on the graphics card, then says what it adds and asks first. Returns whether it was installed.
 */
export async function installPluginFile(file: Blob, name: string): Promise<boolean> {
  let m: PluginManifest;
  try { m = await readPlugin(file); } catch (e) { toast(`Couldn't install ${name}: ${(e as Error).message}.`, 'error'); return false; }
  for (const e of m.effects) {
    const err = fxEngine.compileError(pluginFx(m.id, e));
    if (err) { toast(`Couldn't install ${m.name}: the shader of "${e.label}" has an error: ${err.split('\n').find((l) => l.trim()) ?? err}`, 'error'); return false; }
  }
  const old = installedPlugins().find((p) => p.manifest.id === m.id);
  const adds = [
    m.effects.length ? `${m.effects.length} effect${m.effects.length === 1 ? '' : 's'} (${m.effects.map((e) => e.label).join(', ')})` : '',
    m.commands.length ? `${m.commands.length === 1 ? 'a command' : `${m.commands.length} commands`} (${m.commands.map((c) => c.label).join(', ')})` : '',
    m.panel ? `a panel (${m.panel.title})` : '',
  ].filter(Boolean).join(', ');
  // What it may do: shaders need nothing; a script runs walled off, and can only do what it asks for here.
  const perms = m.permissions.map((p) => PERMISSIONS[p]);
  const trust = !m.main ? 'It needs no permissions: effects run on the graphics card and can\'t reach your files or the internet.'
    : `Its script runs walled off from your files and the internet. ${perms.length ? `It asks to ${perms.join('; to ')}.` : 'It asks for no permissions.'}`;
  const r = await ask(old ? `Update ${m.name}?` : `Install ${m.name}?`,
    `${m.name} ${m.version}${m.author ? ` by ${m.author}` : ''}${m.description ? `: ${m.description}` : '.'} It adds ${adds}, under Filter › Plugins. ${trust}`
    + (old ? ` This replaces version ${old.manifest.version}.` : ''),
    [{ id: 'cancel', label: 'Cancel' }, { id: 'install', label: old ? 'Update' : 'Install', primary: true }]);
  if (r !== 'install') return false;
  closeFrame(m.id); // (an update's script starts afresh)
  installPlugin(m);
  refresh();
  toast(`${old ? 'Updated' : 'Installed'} ${m.name}: find it under Filter › Plugins.`);
  return true;
}

/** Edit › Plugins: what's installed (turn each on or off, or remove it) and installing from a file. */
export function pluginsDialog() {
  const list = h('div', { class: 'plugin-list' });
  const row = (p: InstalledPlugin) => {
    const m = p.manifest;
    return h('div', { class: 'plugin-row' + (p.enabled ? '' : ' off') },
      h('div', { class: 'plugin-info' },
        h('div', null, h('strong', null, m.name), h('span', { class: 'dim' }, ` ${m.version}${m.author ? ` · ${m.author}` : ''}`)),
        m.description ? h('div', { class: 'dim small' }, m.description) : null,
        h('div', { class: 'dim small' }, [
          m.effects.length ? `Effects: ${m.effects.map((e) => e.label).join(', ')}` : '',
          m.commands?.length ? `Commands: ${m.commands.map((c) => c.label).join(', ')}` : '',
          m.panel ? `Panel: ${m.panel.title}` : '',
          m.main ? `Permissions: ${m.permissions.length ? m.permissions.join(', ') : 'none'}` : '',
        ].filter(Boolean).join(' · '))),
      checkbox('On', p.enabled, (v) => { if (!v) closeFrame(m.id); setPluginEnabled(m.id, v); refresh(); render(); }, 'Turn it off to hide what it adds (layers using its effects show nothing until it\'s on again)'),
      h('button', { class: 'btn small', type: 'button', onclick: async () => {
        const a = await ask(`Remove ${m.name}?`, 'Effect layers using its effects stay in your files, showing nothing, until it\'s installed again.',
          [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Remove', primary: true, danger: true }]);
        if (a === 'yes') { closeFrame(m.id); removePlugin(m.id); refresh(); render(); toast(`Removed ${m.name}.`); }
      } }, 'Remove'));
  };
  const render = () => {
    const all = installedPlugins();
    list.replaceChildren(...(all.length ? all.map(row) : [h('p', { class: 'dialog-note' }, 'No plugins installed yet. A plugin is a .pixlplugin file: install it here, or drop it on the window.')]));
  };
  render();
  dialog({
    title: 'Plugins', width: 560,
    body: [list,
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'button', onclick: async () => {
        for (const { file } of await pickFiles('plugin', false)) await installPluginFile(file, file.name);
        render();
      } }, 'Install from file…')),
      h('p', { class: 'dialog-note' }, 'Plugins add effects (shaders), and commands and panels (scripts, which run walled off from your files and the internet, doing only what their permissions allow). They\'re kept when Pixl updates.')],
    buttons: [{ label: 'Close', primary: true }],
  });
}
