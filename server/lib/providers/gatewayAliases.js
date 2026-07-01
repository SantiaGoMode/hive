// ── Gateway capability aliases (single source of truth) ───────────────────────
// The gateway's capability aliases (hive-smart / hive-coding / hive-cheap /
// hive-bigctx) are POOLS defined by repeated `model_name` entries in
// gateway/litellm.config.yaml. Rather than hand-mirror them here (which drifts
// silently when the yaml changes — see issue #38), we DERIVE the list by parsing
// the yaml at startup, deduped and in first-appearance order. If the file can't
// be read/parsed (packaged deploy, odd cwd), we fall back to the known list so
// the picker still works.

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { logSwallowed } = require('../logSwallowed');

// Safe fallback: the aliases as they stood when this was hardcoded. Keep in sync
// only as a last resort — the yaml is the real source of truth.
const FALLBACK_ALIASES = ['hive-smart', 'hive-coding', 'hive-cheap', 'hive-bigctx'];

// gateway/litellm.config.yaml lives at the repo root under gateway/. This file is
// server/lib/providers/gatewayAliases.js, so the config is three dirs up.
const CONFIG_PATH = path.join(__dirname, '..', '..', '..', 'gateway', 'litellm.config.yaml');

// A user-facing capability alias is a plain `hive-*` model_name — NOT a wildcard
// pass-through entry (openai/*, anthropic/*, gemini/*), which is a routing rule,
// not a picker alias.
function isCapabilityAlias(modelName) {
  return typeof modelName === 'string' && /^hive-[a-z0-9-]+$/i.test(modelName) && !modelName.includes('*');
}

// Parse the yaml and return the unique hive-* aliases in first-appearance order.
// Returns the fallback list on any read/parse error or empty result.
function deriveGatewayAliases(configPath = CONFIG_PATH) {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const doc = yaml.load(raw);
    const modelList = doc && Array.isArray(doc.model_list) ? doc.model_list : [];
    const seen = new Set();
    const aliases = [];
    for (const entry of modelList) {
      const name = entry && entry.model_name;
      if (isCapabilityAlias(name) && !seen.has(name)) {
        seen.add(name);
        aliases.push(name);
      }
    }
    if (aliases.length) return aliases;
    logSwallowed('gatewayAliases:empty', new Error('no hive-* aliases found in config'), { configPath });
    return [...FALLBACK_ALIASES];
  } catch (e) {
    logSwallowed('gatewayAliases:parse', e, { configPath });
    return [...FALLBACK_ALIASES];
  }
}

module.exports = { deriveGatewayAliases, FALLBACK_ALIASES, CONFIG_PATH };
