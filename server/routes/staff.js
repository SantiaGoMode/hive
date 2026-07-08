const express = require('express');
const router = express.Router();
const staff = require('../lib/staffDirectory');

router.get('/profiles', (req, res) => {
  const profiles = staff.listProfiles().map(profile => ({
    ...profile,
    metrics: staff.profileMetrics(profile),
    suggestion_count: staff.listSuggestions(profile.id).filter(s => s.status === 'pending').length,
  }));
  res.json({ profiles });
});

router.post('/profiles', (req, res) => {
  try {
    res.status(201).json(staff.createProfile(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/profiles/:id', (req, res) => {
  const result = staff.deleteProfile(req.params.id);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ success: true });
});

router.get('/profiles/:id', (req, res) => {
  const profile = staff.profileBundle(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Staff profile not found' });
  res.json(profile);
});

router.put('/profiles/:id', (req, res) => {
  const profile = staff.updateProfile(req.params.id, req.body || {});
  if (!profile) return res.status(404).json({ error: 'Staff profile not found' });
  res.json(profile);
});

router.post('/profiles/:id/agent', (req, res) => {
  try {
    const result = staff.createAgentFromProfile(req.params.id, req.body || {});
    if (!result) return res.status(404).json({ error: 'Staff profile not found' });
    res.status(result.created ? 201 : 200).json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// What this profile actually injects into a colony run (recipe baseline,
// override status, effective tool union) — makes invisible drift visible.
router.get('/profiles/:id/effective', (req, res) => {
  const config = staff.profileEffectiveConfig(req.params.id);
  if (!config) return res.status(404).json({ error: 'Staff profile not found' });
  res.json(config);
});

// Reset prompt and/or tools back to the CURRENT recipe defaults (and re-pin
// the seed snapshot so the profile auto-follows future recipe changes).
router.post('/profiles/:id/reset', (req, res) => {
  try {
    const profile = staff.resetProfileToRecipe(req.params.id, req.body?.fields);
    if (!profile) return res.status(404).json({ error: 'Staff profile not found' });
    res.json({ success: true, profile });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/profiles/:id/suggestions', (req, res) => {
  const profile = staff.getProfile(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Staff profile not found' });
  res.json({ suggestions: staff.listSuggestions(profile.id) });
});

router.post('/suggestions/:id/apply', (req, res) => {
  const suggestion = staff.applySuggestion(req.params.id, req.body?.proposed_value);
  if (!suggestion) return res.status(404).json({ error: 'Suggestion not found' });
  res.json({ success: true, suggestion, profile: staff.getProfile(suggestion.profile_id) });
});

router.post('/suggestions/:id/dismiss', (req, res) => {
  const suggestion = staff.dismissSuggestion(req.params.id);
  if (!suggestion) return res.status(404).json({ error: 'Suggestion not found' });
  res.json({ success: true, suggestion });
});

router.post('/suggestions/sync', (req, res) => {
  res.json({ suggestions: staff.syncSuggestionsFromEvidence() });
});

module.exports = router;
