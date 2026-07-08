// Media generation tools (`media` group): local text-to-image (FLUX.2-klein,
// e.g. the Ollama model x/flux2-klein) and text-to-speech (Orpheus). Images come
// straight from Ollama's /api/generate `image` field (base64 PNG). Speech shells
// out to a bundled Python script (orpheus_tts.py) that calls Ollama for the SNAC
// audio codes and decodes them to a WAV — the model-controlled text is passed as
// a discrete argv item, never interpolated into a shell string, so a prompt
// can't inject a command. Output files land in the run's artifact directory and
// are registered on colonyContext.generatedArtifacts so the deliverable, colony
// overview, and Discord relay all pick them up.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('./../config');
const { getOllamaUrl } = require('../ollamaUrl');
const artifacts = require('../colonyArtifacts');

const ORPHEUS_SCRIPT = path.join(__dirname, '..', 'media', 'orpheus_tts.py');
const GEN_TIMEOUT_MS = 10 * 60 * 1000; // local media gen is slow; give it room

// Ollama image models (e.g. x/flux2-klein) return the PNG as a base64 field on
// the /api/generate response. Call it and write the decoded bytes.
async function generateImageViaOllama(prompt, model, outPath) {
  const url = `${getOllamaUrl().replace(/\/$/, '')}/api/generate`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: AbortSignal.timeout(GEN_TIMEOUT_MS),
    });
  } catch (e) {
    return { error: `Could not reach Ollama at ${getOllamaUrl()} for image model "${model}" (${e.message}). Pull it (e.g. \`ollama pull ${model}\`) and set media_image_model to its tag.` };
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    if (resp.status === 404) return { error: `Ollama has no model "${model}". Pull it with \`ollama pull ${model}\` or set media_image_model.` };
    return { error: `Ollama image generation failed (HTTP ${resp.status}) ${body.slice(0, 200)}` };
  }
  const data = await resp.json().catch(() => ({}));
  const b64 = data.image || (Array.isArray(data.images) ? data.images[0] : null);
  if (!b64 || typeof b64 !== 'string') {
    return { error: `Model "${model}" did not return an image — confirm it is an image-generation model (its /api/generate response must carry an "image" field).` };
  }
  try {
    fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
  } catch (e) {
    return { error: `Could not write image file (${e.message}).` };
  }
  return { ok: true };
}

function setting(key, fallback) {
  const v = String(config.getSetting(key) || '').trim();
  return v || fallback;
}

// Where a generated file should live. In a colony run that's the run's artifact
// dir; outside one (regular chat) it's a per-agent adhoc dir under the same root.
function outputColonyId(ctx) {
  return ctx?.colonyContext?.colonyId || `adhoc-${String(ctx?.callerAgentId || 'agent').slice(0, 60)}`;
}

function runPython(scriptPath, args) {
  const python = setting('media_python', 'python3');
  return new Promise((resolve) => {
    execFile(python, [scriptPath, ...args], { timeout: GEN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) {
        try { resolve({ ok: true, ...JSON.parse(String(stdout).trim().split('\n').pop() || '{}') }); }
        catch { resolve({ ok: true }); }
        return;
      }
      // The script prints {"error": ...} to stderr for actionable failures.
      let msg = String(stderr || err.message || '').trim();
      try { const parsed = JSON.parse(msg.split('\n').pop()); if (parsed?.error) msg = parsed.error; } catch { /* raw stderr */ }
      if (err.code === 'ENOENT') msg = `Python interpreter "${python}" not found. Set the media_python setting to your Python path.`;
      if (err.killed) msg = `Media generation timed out after ${Math.round(GEN_TIMEOUT_MS / 1000)}s.`;
      resolve({ ok: false, error: msg });
    });
  });
}

function registerArtifact(ctx, entry) {
  if (!ctx?.colonyContext) return;
  (ctx.colonyContext.generatedArtifacts ||= []).push(entry);
}

module.exports = {
  generate_image: {
    group: 'media',
    definition: {
      type: 'function',
      function: {
        name: 'generate_image',
        description: 'Generate an image from a text prompt using the local FLUX.2-klein model (served by Ollama). Saves a PNG to the run\'s artifacts (downloadable in the colony overview and posted to Discord). Use for visuals, mockups, illustrations, and social/marketing assets. Write a vivid, specific prompt.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'Detailed description of the image to generate.' },
            filename: { type: 'string', description: 'Optional output filename (e.g. "hero.png"). A .png extension is enforced.' },
          },
          required: ['prompt'],
        },
      },
    },
    async handler({ prompt, filename }, ctx) {
      const text = String(prompt || '').trim();
      if (!text) return { error: 'prompt is required' };
      const colonyId = outputColonyId(ctx);
      const outName = artifacts.safeFilename(filename || 'image.png', '.png');
      const outPath = path.join(artifacts.artifactsDir(colonyId), outName);
      const model = setting('media_image_model', 'x/flux2-klein:4b');
      const res = await generateImageViaOllama(text, model, outPath);
      if (!res.ok) return { error: res.error || 'Image generation failed.' };
      const name = path.basename(outPath);
      registerArtifact(ctx, { name, mime: artifacts.mimeFor(name), kind: 'image', prompt: text });
      return { success: true, artifact: name, message: `Image saved as ${name}. It will appear in the colony artifacts and be posted to Discord.` };
    },
  },

  generate_speech: {
    group: 'media',
    definition: {
      type: 'function',
      function: {
        name: 'generate_speech',
        description: 'Synthesize speech (text-to-speech) from text using the local Orpheus model via Ollama. Saves a WAV to the run\'s artifacts (downloadable and posted to Discord). Use for voiceovers, audio summaries, and narrated deliverables.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The text to speak.' },
            voice: { type: 'string', description: 'Orpheus voice name (e.g. tara, leah, leo, dan). Default tara.' },
            filename: { type: 'string', description: 'Optional output filename (e.g. "intro.wav"). A .wav extension is enforced.' },
          },
          required: ['text'],
        },
      },
    },
    async handler({ text, voice, filename }, ctx) {
      const body = String(text || '').trim();
      if (!body) return { error: 'text is required' };
      const colonyId = outputColonyId(ctx);
      const outName = artifacts.safeFilename(filename || 'speech.wav', '.wav');
      const outPath = path.join(artifacts.artifactsDir(colonyId), outName);
      const model = setting('media_tts_model', 'orpheus');
      const args = ['--text', body, '--out', outPath, '--model', model,
        '--voice', setting('media_tts_voice', voice || 'tara'), '--ollama', getOllamaUrl()];
      const res = await runPython(ORPHEUS_SCRIPT, args);
      if (!res.ok) return { error: res.error || 'Speech generation failed.' };
      const name = path.basename(outPath);
      registerArtifact(ctx, { name, mime: artifacts.mimeFor(name), kind: 'audio', text: body.slice(0, 200) });
      return { success: true, artifact: name, message: `Speech saved as ${name}. It will appear in the colony artifacts and be posted to Discord.` };
    },
  },
};
