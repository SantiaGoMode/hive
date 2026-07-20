const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const maintenance = require('../lib/databaseMaintenance');
const config = require('../lib/config');

let created = null;
after(() => {
  if (created?.name) fs.rmSync(path.join(config.hiveHome(), 'backups', created.name), { force: true });
});

describe('database maintenance', () => {
  it('passes SQLite quick_check and creates a protected online backup', async () => {
    assert.deepEqual(maintenance.integrityCheck(), { ok: true, messages: ['ok'] });
    created = await maintenance.createBackup();
    assert.ok(created?.name);
    const destination = path.join(config.hiveHome(), 'backups', created.name);
    assert.ok(fs.statSync(destination).size > 0);
    if (process.platform !== 'win32') assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  });
});
