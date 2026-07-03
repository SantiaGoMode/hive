import { describe, expect, it } from 'vitest';
import { filterRecommendations, localModelBudgetGb, recommendedOllamaModels, stretchModelBudgetGb } from './ollamaRecommendations';

const gb = (n) => n * 1024 ** 3;

describe('ollama local model recommendations', () => {
  it('uses a conservative memory budget from total system RAM', () => {
    expect(localModelBudgetGb({ total: gb(16) })).toBe(12);
    expect(stretchModelBudgetGb({ total: gb(16) })).toBe(14);
    expect(localModelBudgetGb({ total: gb(32) })).toBe(24);
    expect(stretchModelBudgetGb({ total: gb(32) })).toBe(29);
  });

  it('shows over-budget models with fit "over" instead of hiding them', () => {
    const recs = recommendedOllamaModels({ total: gb(16) });
    const names = recs.map(m => m.name);
    expect(names).toContain('llama3.2:3b');
    expect(names).toContain('qwen2.5:7b');
    expect(names).toContain('qwen2.5-coder:14b');
    // Big models are no longer silently dropped — they're labeled.
    expect(recs.find(m => m.name === 'qwen2.5-coder:32b').fit).toBe('over');
    expect(recs.find(m => m.name === 'gemma3:27b').fit).toBe('over');
    // Over-budget sorts after comfortable/stretch.
    const fitOrder = recs.filter(m => !m.installed).map(m => m.fit);
    expect(fitOrder.indexOf('over')).toBeGreaterThan(fitOrder.lastIndexOf('comfortable'));
  });

  it('filters by family, query, and sorts by size', () => {
    const recs = recommendedOllamaModels({ total: gb(38) });
    const coding = filterRecommendations(recs, { family: 'Coding' });
    expect(coding.every(m => m.family === 'Coding')).toBe(true);
    const q = filterRecommendations(recs, { query: 'gemma3:27' });
    expect(q.map(m => m.name)).toContain('gemma3:27b');
    const desc = filterRecommendations(recs, { sort: 'size-desc' });
    expect(desc[0].estimatedRamGb).toBeGreaterThanOrEqual(desc[desc.length - 1].estimatedRamGb);
  });

  it('includes relevant high-memory coding models on larger systems', () => {
    const recs = recommendedOllamaModels({ total: gb(38) });
    const names = recs.map(m => m.name);
    expect(names).toContain('qwen3-coder:30b');
    expect(names).toContain('qwen2.5-coder:32b');
    expect(names).toContain('codellama:34b');
    expect(names).toContain('deepseek-coder-v2:16b');
    expect(names).not.toContain('llama3.3:70b');
    expect(recs.find(m => m.name === 'qwen3-coder:30b').fit).toBe('comfortable');
  });

  it('marks already installed models', () => {
    const recs = recommendedOllamaModels({ total: gb(16) }, [{ name: 'qwen2.5:7b' }]);
    expect(recs.find(m => m.name === 'qwen2.5:7b').installed).toBe(true);
  });
});
