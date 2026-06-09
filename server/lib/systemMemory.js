const os = require('os');
const { execFileSync } = require('child_process');

function parseVmStat(output) {
  const pageSizeMatch = output.match(/page size of\s+(\d+)\s+bytes/i);
  const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 4096;
  const pages = {};

  for (const line of output.split('\n')) {
    const match = line.match(/^"?([^":]+)"?:\s+([\d.]+)\.?$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase().replace(/[\s-]+/g, '_');
    pages[key] = Number(match[2]);
  }

  return { pageSize, pages };
}

function bytes(pages, pageSize) {
  return Math.max(0, Number(pages || 0)) * pageSize;
}

function memoryFromVmStat(output, total = os.totalmem()) {
  const { pageSize, pages } = parseVmStat(output);
  const free = bytes(pages.pages_free, pageSize);
  const speculative = bytes(pages.pages_speculative, pageSize);
  const fileBacked = bytes(pages.file_backed_pages, pageSize);
  const purgeable = bytes(pages.pages_purgeable, pageSize);
  const cached = fileBacked + purgeable;
  const available = Math.min(total, free + speculative + cached);
  const used = Math.max(0, total - available);

  return {
    total,
    free,
    used,
    available,
    cached,
    source: 'macos_vm_stat',
  };
}

function nodeMemory() {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    total,
    free,
    used: total - free,
    available: free,
    cached: 0,
    source: 'node_os',
  };
}

function getSystemMemory() {
  if (process.platform === 'darwin') {
    try {
      const output = execFileSync('vm_stat', { encoding: 'utf8', timeout: 1500 });
      return memoryFromVmStat(output, os.totalmem());
    } catch {}
  }
  return nodeMemory();
}

module.exports = { getSystemMemory, memoryFromVmStat, parseVmStat, nodeMemory };
