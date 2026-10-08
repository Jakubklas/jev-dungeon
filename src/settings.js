// Compatibility shim: the tunables now live in src/config/ (registry.js, load.js, runtime.js; see PLAN-central-config.md).
// hub.js, server.js and the checks keep importing from here.
export { SCHEMA, defaults, validate, loadSettings, refresh, saveSettings, applyNextGame, view, appliedValue, configFile, userView, saveUserSettings } from './config/runtime.js';
