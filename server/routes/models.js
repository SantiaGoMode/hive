const express = require('express');
const router = express.Router();
const { listAllModels, testProvider } = require('../lib/providers/listModels');

// Unified, provider-grouped model list (live + curated fallback).
router.get('/', async (req, res) => {
  try {
    const grouped = await listAllModels();
    res.json(grouped);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Test a provider's configured key by listing its models.
router.get('/test/:provider', async (req, res) => {
  try {
    const result = await testProvider(req.params.provider);
    res.json(result);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
