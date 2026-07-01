// Thin entrypoint for the colony API. The ~775-line implementation was split
// into focused modules under ./colony/ (see ./colony/index.js for the layout).
// This file preserves the stable require path (require('./routes/colony')) and
// the same exported express Router mounted at /api/colony in server/index.js.
module.exports = require('./colony/index');
