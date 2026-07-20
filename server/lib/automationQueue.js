// Process-wide backpressure for non-Colony unattended work. Colony has its own
// durable queue; this prevents webhook/schedule agent and pipeline calls from
// creating unbounded concurrent model/tool workloads.
const MAX_CONCURRENT = Math.max(1, Number(process.env.HIVE_MAX_CONCURRENT_AUTOMATION_RUNS) || 4);
const pending = [];
let active = 0;

function drain() {
  while (active < MAX_CONCURRENT && pending.length > 0) {
    const item = pending.shift();
    active += 1;
    Promise.resolve()
      .then(item.task)
      .then(item.resolve, item.reject)
      .finally(() => {
        active -= 1;
        setImmediate(drain);
      });
  }
}

function scheduleAutomation(task) {
  return new Promise((resolve, reject) => {
    pending.push({ task, resolve, reject });
    setImmediate(drain);
  });
}

function status() {
  return { active, queued: pending.length, max_concurrent: MAX_CONCURRENT };
}

module.exports = { scheduleAutomation, status };
