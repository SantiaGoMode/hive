const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const router = express.Router();
const db = require('../db');

const DASH_DIR = path.join(os.homedir(), '.hive');

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});

router.put('/', (req, res) => {
  const allowed = ['ollama_url', 'theme', 'accent_color', 'font_size'];
  const stmt = db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)');
  for (const key of allowed) {
    if (req.body[key] !== undefined) stmt.run(key, req.body[key]);
  }
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});

router.delete('/shared-blackboard', (req, res) => {
  try {
    const sharedFile = path.join(DASH_DIR, 'shared', 'SHARED.md');
    if (fs.existsSync(sharedFile)) fs.writeFileSync(sharedFile, '', 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
