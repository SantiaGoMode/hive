#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const CONFIG_PATH = path.join(__dirname, '..', 'gateway', 'litellm.config.yaml');

const ALLOWED_MODELS = {
  anthropic: new Set([
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
  ]),
  openai: new Set([
    'gpt-4o',
    'gpt-4o-mini',
  ]),
  gemini: new Set([
    'gemini-2.5-pro',
    'gemini-2.5-flash',
  ]),
};

function fail(message) {
  console.error(`gateway model validation failed: ${message}`);
  process.exitCode = 1;
}

function modelParts(model) {
  const [provider, ...rest] = String(model || '').split('/');
  return { provider, id: rest.join('/') };
}

function collectFallbackTargets(routerSettings = {}) {
  const targets = new Set();
  for (const key of ['fallbacks', 'context_window_fallbacks']) {
    for (const group of routerSettings[key] || []) {
      for (const [from, tos] of Object.entries(group || {})) {
        targets.add(from);
        for (const to of tos || []) targets.add(to);
      }
    }
  }
  return targets;
}

const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
const config = yaml.load(raw);
const deployments = config.model_list || [];
const modelNames = new Set(deployments.map(entry => entry.model_name).filter(Boolean));

for (const entry of deployments) {
  const model = entry?.litellm_params?.model;
  if (!model) {
    fail(`deployment ${entry?.model_name || '<unnamed>'} is missing litellm_params.model`);
    continue;
  }
  if (String(model).endsWith('/*')) continue;

  const { provider, id } = modelParts(model);
  if (!ALLOWED_MODELS[provider]) {
    fail(`${entry.model_name} points at unsupported provider "${provider}" (${model})`);
    continue;
  }
  if (!ALLOWED_MODELS[provider].has(id)) {
    fail(`${entry.model_name} points at unknown ${provider} model "${id}"`);
  }
}

for (const target of collectFallbackTargets(config.router_settings)) {
  if (!modelNames.has(target)) {
    fail(`router fallback references missing model_name "${target}"`);
  }
}

if (!process.exitCode) {
  console.log(`Validated ${deployments.length} gateway deployments in ${path.relative(process.cwd(), CONFIG_PATH)}`);
}
