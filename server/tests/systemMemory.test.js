const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { memoryFromVmStat, parseVmStat } = require('../lib/systemMemory');

const VM_STAT_SAMPLE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   100.
Pages active:                                 400.
Pages inactive:                               300.
Pages speculative:                             50.
Pages wired down:                             200.
Pages purgeable:                               25.
"Translation faults":                     123456.
File-backed pages:                            250.
Anonymous pages:                              450.
Pages occupied by compressor:                 75.
`;

describe('systemMemory macOS vm_stat parsing', () => {
  it('parses page size and vm_stat page counters', () => {
    const out = parseVmStat(VM_STAT_SAMPLE);
    assert.equal(out.pageSize, 16384);
    assert.equal(out.pages.pages_free, 100);
    assert.equal(out.pages.pages_speculative, 50);
    assert.equal(out.pages.file_backed_pages, 250);
    assert.equal(out.pages.pages_purgeable, 25);
  });

  it('excludes cached file-backed and purgeable pages from used memory', () => {
    const page = 16384;
    const total = 1200 * page;
    const out = memoryFromVmStat(VM_STAT_SAMPLE, total);

    assert.equal(out.free, 100 * page);
    assert.equal(out.cached, (250 + 25) * page);
    assert.equal(out.available, (100 + 50 + 250 + 25) * page);
    assert.equal(out.used, (1200 - 100 - 50 - 250 - 25) * page);
    assert.equal(out.source, 'macos_vm_stat');
  });
});
