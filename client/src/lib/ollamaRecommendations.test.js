import { describe, expect, it } from 'vitest';
import { localModelBudgetGb, recommendedOllamaModels, stretchModelBudgetGb } from './ollamaRecommendations';

const gb = (n) => n * 1024 ** 3;

describe('ollama local model recommendations', () => {
  it('uses a conservative memory budget from total system RAM', () => {
    expect(localModelBudgetGb({ total: gb(16) })).toBe(12);
    expect(stretchModelBudgetGb({ total: gb(16) })).toBe(14);
    expect(localModelBudgetGb({ total: gb(32) })).toBe(24);
    expect(stretchModelBudgetGb({ total: gb(32) })).toBe(29);
  });

  it('filters out models that exceed the current system budget', () => {
    const names = recommendedOllamaModels({ total: gb(16) }).map(m => m.name);
    expect(names).toContain('llama3.2:3b');
    expect(names).toContain('qwen2.5:7b');
    expect(names).toContain('qwen2.5-coder:14b');
    expect(names).toContain('codellama:13b');
    expect(names).not.toContain('qwen2.5-coder:32b');
    expect(names).not.toContain('llama3.3:70b');
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
