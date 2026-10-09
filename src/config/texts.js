// The built-in prompt wording, by registry key (what a text knob means when it is null). Collected from the modules that own the
// text, copied by each at load before any config is applied, so the YAML template can show the real wording.
import { explorerPromptDefaults } from '../characters/explorer/brain.js';
import { explorerRemarkDefaults } from '../characters/explorer/encounter.js';
import { characterPromptDefaults, } from '../characters/adversary/character.js';
import { monsterPromptDefaults } from '../characters/adversary/memory.js';
import { skillPromptDefaults } from '../skills/question.js';
import { THOUGHTS, MOOD_THOUGHTS, TROLL_THOUGHTS, TREE_GIANT_THOUGHTS, WOLF_THOUGHTS } from '../../public/thoughts.js';

// The browser's bubble lines (public/thoughts.js), keyed th_<approach>, thm_<mood>, tht_<troll>, thg_<tree giant>, thw_<wolf>.
export const thoughtDefaults = () => ({
  ...Object.fromEntries(Object.entries(THOUGHTS).map(([id, l]) => [`th_${id}`, [...l]])),
  ...Object.fromEntries(Object.entries(MOOD_THOUGHTS).map(([id, l]) => [`thm_${id}`, [...l]])),
  ...Object.fromEntries(Object.entries(TROLL_THOUGHTS).map(([id, l]) => [`tht_${id}`, [...l]])),
  ...Object.fromEntries(Object.entries(TREE_GIANT_THOUGHTS).map(([id, l]) => [`thg_${id}`, [...l]])),
  ...Object.fromEntries(Object.entries(WOLF_THOUGHTS).map(([id, l]) => [`thw_${id}`, [...l]])),
});
let all = null;
export function builtinText(key) {
  all ??= { ...explorerPromptDefaults(), ...characterPromptDefaults(), ...monsterPromptDefaults(), ...skillPromptDefaults(), ...thoughtDefaults(), ...explorerRemarkDefaults() };
  return all[key];
}
