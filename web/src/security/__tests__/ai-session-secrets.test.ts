import assert from 'node:assert/strict';
import {
  clearAiSessionSecrets,
  getAiSessionSecret,
  purgeLegacyAiSecretStorage,
  redactAiSecrets,
  setAiSessionSecret,
} from '../AiSessionSecrets';

clearAiSessionSecrets();
assert.equal(getAiSessionSecret('gemini'), null);
setAiSessionSecret('gemini', '  gem-secret  ');
setAiSessionSecret('openai', 'open-secret');
assert.equal(getAiSessionSecret('gemini'), 'gem-secret');
assert.equal(redactAiSecrets('gem-secret and open-secret'), '[REDACTED] and [REDACTED]');

const removed: string[] = [];
purgeLegacyAiSecretStorage({ removeItem: (key) => removed.push(key) });
assert.deepEqual(removed, ['orca_gemini_key', 'orca_openai_key']);

clearAiSessionSecrets();
assert.equal(getAiSessionSecret('openai'), null);
console.log('AI session-secret tests passed');
