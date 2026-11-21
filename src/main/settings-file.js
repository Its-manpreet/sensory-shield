// OWNER: Agent A. Persists settings as JSON in Electron's userData folder. Settings only, never frames.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { defaultSettings, migrateSettings } from '../shared/profiles.js';

const file = () => path.join(app.getPath('userData'), 'settings.json');

export function loadSettings() {
  try {
    return migrateSettings(JSON.parse(fs.readFileSync(file(), 'utf8')));
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(settings, null, 2));
}
