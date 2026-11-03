import { restoreSettings } from './core/settings';

// Settings are put back from the settings file (if the web view lost them) before the app reads them.
await restoreSettings();
// Installed plugins too, so files using their effects (and recovered work) find them.
await (await import('./core/plugins')).loadPlugins();
await import('./main');
