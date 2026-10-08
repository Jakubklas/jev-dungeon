// The built-in prompt wording, by registry key (what a text knob means when it is null). Collected from the modules that own the
// text, copied by each at load before any config is applied, so the YAML template can show the real wording.
import { explorerPromptDefaults } from '../characters/explorer/brain.js';
import { characterPromptDefaults, } from '../characters/adversary/character.js';
import { monsterPromptDefaults } from '../characters/adversary/memory.js';
import { skillPromptDefaults } from '../skills/question.js';

let all = null;
export function builtinText(key) {
  all ??= { ...explorerPromptDefaults(), ...characterPromptDefaults(), ...monsterPromptDefaults(), ...skillPromptDefaults() };
  return all[key];
}
