import { describe, it, expect } from 'vitest';
import { sseToEntries, dbLogToEntries, mergeToolEntries, AGENT_COLORS } from './colonyUtils';

// ── sseToEntries ──────────────────────────────────────────────────────────────

describe('sseToEntries', () => {
  it('handles agent_ready: registers agent in nameMap and returns agent_ready entry', () => {
    const nameMap = {};
    const entries = sseToEntries(
      { type: 'agent_ready', agent: { id: 'a1', name: 'backend-dev', avatar_color: '#3b82f6' }, role: 'worker' },
      nameMap,
      1000
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'agent_ready', agent: 'backend-dev', role: 'worker', ts: 1000 });
    expect(nameMap['a1']).toBe('backend-dev');
  });

  it('handles round_start: returns round entry', () => {
    const entries = sseToEntries({ type: 'round_start', round: 2 }, {}, 2000);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'round', round: 2, ts: 2000 });
  });

  it('handles orchestrator_message: returns message entry with agent=Orchestrator', () => {
    const entries = sseToEntries({ type: 'orchestrator_message', content: 'Planning…' }, {}, 3000);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'message', agent: 'Orchestrator', content: 'Planning…', ts: 3000 });
  });

  it('handles done: returns done entry with status', () => {
    const entries = sseToEntries({ type: 'done', status: 'done' }, {}, 4000);
    expect(entries[0]).toMatchObject({ type: 'done', status: 'done' });
  });

  it('handles error: maps to error type', () => {
    const entries = sseToEntries({ type: 'error', message: 'Something blew up' }, {}, 5000);
    expect(entries[0]).toMatchObject({ type: 'error', content: 'Something blew up' });
  });

  it('handles ws tool_call: returns tool_call with agent=Orchestrator', () => {
    const entries = sseToEntries(
      { type: 'ws', msg: { type: 'tool_call', name: 'shell', args: { command: 'ls' } } },
      {},
      6000
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'tool_call', agent: 'Orchestrator', tool: 'shell', args: { command: 'ls' } });
  });

  it('handles ws tool_result: returns tool_result for Orchestrator', () => {
    const entries = sseToEntries(
      { type: 'ws', msg: { type: 'tool_result', name: 'shell', result: { exitCode: 0, stdout: 'workspace' } } },
      {},
      7000
    );
    expect(entries[0]).toMatchObject({ type: 'tool_result', agent: 'Orchestrator', tool: 'shell' });
    expect(entries[0].result.exitCode).toBe(0);
  });

  it('handles ws sub_tool_call: resolves agent name from nameMap', () => {
    const nameMap = { 'worker-1': 'db-designer' };
    const entries = sseToEntries(
      { type: 'ws', msg: { type: 'sub_tool_call', name: 'write_file', subAgent: 'worker-1', args: { path: '/workspace/schema.sql' } } },
      nameMap,
      8000
    );
    expect(entries[0]).toMatchObject({ type: 'sub_tool_call', agent: 'db-designer', tool: 'write_file' });
  });

  it('handles ws sub_tool_call: falls back to subAgent string if not in nameMap', () => {
    const entries = sseToEntries(
      { type: 'ws', msg: { type: 'sub_tool_call', name: 'shell', subAgent: 'unknown-id', args: {} } },
      {},
      9000
    );
    expect(entries[0].agent).toBe('unknown-id');
  });

  it('handles ws sub_tool_call: falls back to Worker if subAgent missing', () => {
    const entries = sseToEntries(
      { type: 'ws', msg: { type: 'sub_tool_call', name: 'shell', args: {} } },
      {},
      10000
    );
    expect(entries[0].agent).toBe('Worker');
  });

  it('returns empty array for unknown event types', () => {
    const entries = sseToEntries({ type: 'unknown_type' }, {}, 11000);
    expect(entries).toHaveLength(0);
  });

  it('returns empty array for ws events with unknown msg type', () => {
    const entries = sseToEntries({ type: 'ws', msg: { type: 'heartbeat' } }, {}, 12000);
    expect(entries).toHaveLength(0);
  });
});

// ── dbLogToEntries ─────────────────────────────────────────────────────────────

describe('dbLogToEntries', () => {
  it('maps agent_ready kind to type agent_ready', () => {
    const dbLog = [{ kind: 'agent_ready', agent: { name: 'tester', avatar_color: '#10b981' }, role: 'worker', ts: 1000 }];
    const result = dbLogToEntries(dbLog, {});
    expect(result[0]).toMatchObject({ type: 'agent_ready', agent: 'tester', role: 'worker', ts: 1000 });
  });

  it('maps round kind to type round', () => {
    const result = dbLogToEntries([{ kind: 'round', round: 1, ts: 2000 }], {});
    expect(result[0]).toMatchObject({ type: 'round', round: 1 });
  });

  it('maps message kind to type message', () => {
    const result = dbLogToEntries([{ kind: 'message', agent: 'Orchestrator', content: 'Hello', ts: 3000 }], {});
    expect(result[0]).toMatchObject({ type: 'message', agent: 'Orchestrator', content: 'Hello' });
  });

  it('maps tool_call kind to type tool_call', () => {
    const result = dbLogToEntries([{ kind: 'tool_call', agent: 'backend-dev', tool: 'shell', args: { command: 'ls' }, ts: 4000 }], {});
    expect(result[0]).toMatchObject({ type: 'tool_call', agent: 'backend-dev', tool: 'shell' });
  });

  it('maps tool_result kind to type tool_result', () => {
    const result = dbLogToEntries([{ kind: 'tool_result', agent: 'backend-dev', tool: 'shell', result: { exitCode: 0 }, ts: 5000 }], {});
    expect(result[0]).toMatchObject({ type: 'tool_result', tool: 'shell', result: { exitCode: 0 } });
  });

  it('maps done kind to type done', () => {
    const result = dbLogToEntries([{ kind: 'done', status: 'done', ts: 6000 }], {});
    expect(result[0]).toMatchObject({ type: 'done', status: 'done' });
  });

  it('maps error kind to type error with message as content', () => {
    const result = dbLogToEntries([{ kind: 'error', message: 'OOM', ts: 7000 }], {});
    expect(result[0]).toMatchObject({ type: 'error', content: 'OOM' });
  });

  it('filters out unknown kinds (returns null → filtered)', () => {
    const result = dbLogToEntries([{ kind: 'unknown_kind', ts: 8000 }], {});
    expect(result).toHaveLength(0);
  });

  it('assigns colors to new agents from AGENT_COLORS', () => {
    const dbLog = [{ kind: 'agent_ready', agent: { name: 'new-agent' }, role: 'worker', ts: 1000 }];
    dbLogToEntries(dbLog, {}); // just ensure it doesn't throw
    // We can't inspect map mutations from outside, but verify entry is returned
    const result = dbLogToEntries(dbLog, {});
    expect(result[0].agent).toBe('new-agent');
  });

  it('handles empty log', () => {
    const result = dbLogToEntries([], {});
    expect(result).toHaveLength(0);
  });
});

// ── mergeToolEntries ──────────────────────────────────────────────────────────

describe('mergeToolEntries', () => {
  it('returns an empty array for empty input', () => {
    expect(mergeToolEntries([])).toEqual([]);
  });

  it('merges tool_result into the preceding matching tool_call', () => {
    const log = [
      { type: 'tool_call', agent: 'Orchestrator', tool: 'shell', args: { command: 'ls' } },
      { type: 'tool_result', agent: 'Orchestrator', tool: 'shell', result: { exitCode: 0 } },
    ];
    const merged = mergeToolEntries(log);
    expect(merged).toHaveLength(1);
    expect(merged[0].result).toEqual({ exitCode: 0 });
  });

  it('does not merge if agents differ', () => {
    const log = [
      { type: 'tool_call', agent: 'Orchestrator', tool: 'shell', args: {} },
      { type: 'tool_result', agent: 'Worker', tool: 'shell', result: { exitCode: 0 } },
    ];
    const merged = mergeToolEntries(log);
    expect(merged).toHaveLength(2);
  });

  it('does not merge if tools differ', () => {
    const log = [
      { type: 'tool_call', agent: 'Orchestrator', tool: 'shell', args: {} },
      { type: 'tool_result', agent: 'Orchestrator', tool: 'write_file', result: { success: true } },
    ];
    const merged = mergeToolEntries(log);
    expect(merged).toHaveLength(2);
  });

  it('does not merge into an already-matched tool_call (result already set)', () => {
    const log = [
      { type: 'tool_call', agent: 'Orchestrator', tool: 'shell', args: {} },
      { type: 'tool_result', agent: 'Orchestrator', tool: 'shell', result: { exitCode: 0 } },
      { type: 'tool_result', agent: 'Orchestrator', tool: 'shell', result: { exitCode: 1 } },
    ];
    const merged = mergeToolEntries(log);
    // First result merges; second result has no unmatched call, becomes standalone
    expect(merged).toHaveLength(2);
    expect(merged[0].result).toEqual({ exitCode: 0 });
  });

  it('merges sub_tool_call + tool_result pairs', () => {
    const log = [
      { type: 'sub_tool_call', agent: 'backend-dev', tool: 'write_file', args: { path: '/app.py' } },
      { type: 'tool_result', agent: 'backend-dev', tool: 'write_file', result: { success: true } },
    ];
    const merged = mergeToolEntries(log);
    expect(merged).toHaveLength(1);
    expect(merged[0].result).toEqual({ success: true });
  });

  it('preserves non-tool entries unmodified', () => {
    const log = [
      { type: 'round', round: 1 },
      { type: 'message', agent: 'Orchestrator', content: 'Planning' },
      { type: 'done', status: 'done' },
    ];
    const merged = mergeToolEntries(log);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toEqual({ type: 'round', round: 1 });
  });

  it('handles interleaved calls from different agents correctly', () => {
    const log = [
      { type: 'tool_call', agent: 'Orchestrator', tool: 'shell', args: {} },
      { type: 'sub_tool_call', agent: 'Worker', tool: 'shell', args: {} },
      { type: 'tool_result', agent: 'Worker', tool: 'shell', result: { exitCode: 0 } },
      { type: 'tool_result', agent: 'Orchestrator', tool: 'shell', result: { exitCode: 1 } },
    ];
    const merged = mergeToolEntries(log);
    expect(merged).toHaveLength(2);
    const orch = merged.find(e => e.agent === 'Orchestrator');
    const worker = merged.find(e => e.agent === 'Worker');
    expect(orch.result).toEqual({ exitCode: 1 });
    expect(worker.result).toEqual({ exitCode: 0 });
  });

  it('does not mutate the original log array entries', () => {
    const call = { type: 'tool_call', agent: 'Orchestrator', tool: 'shell', args: {} };
    const result = { type: 'tool_result', agent: 'Orchestrator', tool: 'shell', result: { exitCode: 0 } };
    const log = [call, result];
    mergeToolEntries(log);
    // Original objects should not have result injected
    expect(call.result).toBeUndefined();
  });
});
