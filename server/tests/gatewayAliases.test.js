const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

const {
  deriveGatewayAliases, FALLBACK_ALIASES, CONFIG_PATH,
} = require('../lib/providers/gatewayAliases');

// #38 — the gateway alias list must be DERIVED from gateway/litellm.config.yaml
// so it can't drift, with a safe fallback when the config is unavailable.
describe('gateway alias derivation (#38)', () => {
  it('derives exactly the hive-* aliases present in the real config, deduped', () => {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const doc = yaml.load(raw);
    // Independently compute the expected unique hive-* aliases in first-seen order.
    const seen = new Set();
    const expected = [];
    for (const e of doc.model_list) {
      const n = e && e.model_name;
      if (typeof n === 'string' && /^hive-[a-z0-9-]+$/i.test(n) && !seen.has(n)) {
        seen.add(n);
        expected.push(n);
      }
    }
    assert.ok(expected.length > 0, 'config has at least one hive-* alias');
    assert.deepEqual(deriveGatewayAliases(), expected);
  });

  it('excludes wildcard pass-through model_names (openai/*, anthropic/*, gemini/*)', () => {
    const aliases = deriveGatewayAliases();
    assert.ok(!aliases.some(a => a.includes('*')), 'no wildcard entries leak in');
    assert.ok(aliases.every(a => a.startsWith('hive-')), 'only hive-* capability aliases');
  });

  it('falls back to the known list when the config file is missing', () => {
    assert.deepEqual(deriveGatewayAliases('/no/such/litellm.config.yaml'), FALLBACK_ALIASES);
  });

  it('falls back when the config is present but has no hive-* aliases', () => {
    const tmp = path.join(os.tmpdir(), `litellm-nohive-${process.pid}-${Date.now()}.yaml`);
    fs.writeFileSync(tmp, yaml.dump({ model_list: [{ model_name: 'openai/*' }, { model_name: 'anthropic/*' }] }));
    try {
      assert.deepEqual(deriveGatewayAliases(tmp), FALLBACK_ALIASES);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('falls back when the config is unparseable', () => {
    const tmp = path.join(os.tmpdir(), `litellm-bad-${process.pid}-${Date.now()}.yaml`);
    fs.writeFileSync(tmp, 'model_list: [ this is: not: valid: yaml');
    try {
      assert.deepEqual(deriveGatewayAliases(tmp), FALLBACK_ALIASES);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('picks up a new alias added to the config (drift guard)', () => {
    const tmp = path.join(os.tmpdir(), `litellm-extra-${process.pid}-${Date.now()}.yaml`);
    fs.writeFileSync(tmp, yaml.dump({
      model_list: [
        { model_name: 'openai/*' },
        { model_name: 'hive-smart' },
        { model_name: 'hive-smart' }, // duplicate pool entry — should dedupe
        { model_name: 'hive-newcap' },
      ],
    }));
    try {
      assert.deepEqual(deriveGatewayAliases(tmp), ['hive-smart', 'hive-newcap']);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
