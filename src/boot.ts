import { restoreSettings } from './core/settings';

// Settings are put back from the settings file (if the web view lost them) before the app reads them.
await restoreSettings();
await import('./main');
