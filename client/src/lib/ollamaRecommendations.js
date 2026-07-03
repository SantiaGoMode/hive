export const OLLAMA_RECOMMENDATIONS = [
  // Small / fast
  { name: 'llama3.2:1b', title: 'Llama 3.2 1B', family: 'Small', sizeLabel: '1B', estimatedRamGb: 1.5, description: 'Tiny, fast local assistant for quick drafts and light tasks.' },
  { name: 'llama3.2:3b', title: 'Llama 3.2 3B', family: 'Small', sizeLabel: '3B', estimatedRamGb: 3, description: 'Fast everyday assistant for smaller systems.' },
  { name: 'gemma3:1b', title: 'Gemma 3 1B', family: 'Small', sizeLabel: '1B', estimatedRamGb: 1.5, description: 'Very small general model for low-latency runs.' },
  { name: 'gemma3:4b', title: 'Gemma 3 4B', family: 'Small', sizeLabel: '4B', estimatedRamGb: 4, description: 'Compact general model with strong speed.' },
  { name: 'phi3:mini', title: 'Phi 3 Mini', family: 'Small', sizeLabel: '3.8B', estimatedRamGb: 4, description: 'Lightweight reasoning model for simple local tasks.' },
  { name: 'phi4-mini', title: 'Phi 4 Mini', family: 'Small', sizeLabel: 'Mini', estimatedRamGb: 4, description: 'Small Microsoft model for responsive local reasoning.' },
  { name: 'stable-code', title: 'Stable Code', family: 'Coding', sizeLabel: '3B', estimatedRamGb: 3, description: 'Small coding model for completion and generation.' },

  // General chat
  { name: 'mistral:7b', title: 'Mistral 7B', family: 'General', sizeLabel: '7B', estimatedRamGb: 5, description: 'Fast, reliable general-purpose local model.' },
  { name: 'llama3.1:8b', title: 'Llama 3.1 8B', family: 'General', sizeLabel: '8B', estimatedRamGb: 6, description: 'Strong general chat model with broad compatibility.' },
  { name: 'llama3.2', title: 'Llama 3.2', family: 'General', sizeLabel: '3B', estimatedRamGb: 3, description: 'Default Llama 3.2 tag, good for quick local use.' },
  { name: 'gemma3:12b', title: 'Gemma 3 12B', family: 'General', sizeLabel: '12B', estimatedRamGb: 8, description: 'Mid-size general model with good quality per GB.' },
  { name: 'mistral-nemo:12b', title: 'Mistral Nemo 12B', family: 'General', sizeLabel: '12B', estimatedRamGb: 8, description: 'Larger local general model for machines with more memory.' },
  { name: 'dolphin3', title: 'Dolphin 3', family: 'General', sizeLabel: '8B', estimatedRamGb: 6, description: 'General-purpose model tuned for helpful instruction following.' },
  { name: 'olmo2:7b', title: 'OLMo 2 7B', family: 'General', sizeLabel: '7B', estimatedRamGb: 5, description: 'Open general model for local experiments.' },
  { name: 'olmo2:13b', title: 'OLMo 2 13B', family: 'General', sizeLabel: '13B', estimatedRamGb: 9, description: 'Larger OLMo 2 variant for higher-quality general use.' },
  { name: 'gemma3:27b', title: 'Gemma 3 27B', family: 'General', sizeLabel: '27B', estimatedRamGb: 18, description: 'High-quality general model for high-memory systems.' },
  { name: 'command-r:35b', title: 'Command R 35B', family: 'General', sizeLabel: '35B', estimatedRamGb: 24, description: 'Larger model for chat, RAG, and document-heavy work.' },

  // Agent / tool use
  { name: 'qwen2.5:7b', title: 'Qwen 2.5 7B', family: 'Agents', sizeLabel: '7B', estimatedRamGb: 5, description: 'Good balance for tool use, agents, and everyday tasks.' },
  { name: 'qwen2.5:14b', title: 'Qwen 2.5 14B', family: 'Agents', sizeLabel: '14B', estimatedRamGb: 9, description: 'Stronger agent/tool-use model for more complex tasks.' },
  { name: 'qwen2.5:32b', title: 'Qwen 2.5 32B', family: 'Agents', sizeLabel: '32B', estimatedRamGb: 22, description: 'Large agent-capable model for high-memory machines.' },
  { name: 'qwen3:8b', title: 'Qwen 3 8B', family: 'Agents', sizeLabel: '8B', estimatedRamGb: 6, description: 'Newer Qwen model for agentic and reasoning workflows.' },
  { name: 'qwen3:14b', title: 'Qwen 3 14B', family: 'Agents', sizeLabel: '14B', estimatedRamGb: 10, description: 'Mid-size Qwen 3 for tool-heavy agent workflows.' },
  { name: 'qwen3:32b', title: 'Qwen 3 32B', family: 'Agents', sizeLabel: '32B', estimatedRamGb: 23, description: 'Large Qwen 3 variant for high-memory agent runs.' },
  { name: 'llama3-groq-tool-use:8b', title: 'Llama 3 Groq Tool Use 8B', family: 'Agents', sizeLabel: '8B', estimatedRamGb: 6, description: 'Tool-use focused model for function calling.' },

  // Coding
  { name: 'qwen2.5-coder:0.5b', title: 'Qwen Coder 0.5B', family: 'Coding', sizeLabel: '0.5B', estimatedRamGb: 1, description: 'Tiny coding model for lightweight code completion.' },
  { name: 'qwen2.5-coder:1.5b', title: 'Qwen Coder 1.5B', family: 'Coding', sizeLabel: '1.5B', estimatedRamGb: 2, description: 'Small coding assistant for fast local edits.' },
  { name: 'qwen2.5-coder:3b', title: 'Qwen Coder 3B', family: 'Coding', sizeLabel: '3B', estimatedRamGb: 3, description: 'Fast coding model for smaller projects.' },
  { name: 'qwen2.5-coder:7b', title: 'Qwen Coder 7B', family: 'Coding', sizeLabel: '7B', estimatedRamGb: 5, description: 'Strong coding model with modest memory needs.' },
  { name: 'qwen2.5-coder:14b', title: 'Qwen Coder 14B', family: 'Coding', sizeLabel: '14B', estimatedRamGb: 9, description: 'Coding-focused model for development workflows.' },
  { name: 'qwen2.5-coder:32b', title: 'Qwen Coder 32B', family: 'Coding', sizeLabel: '32B', estimatedRamGb: 22, description: 'Higher-capacity coding model for high-memory systems.' },
  { name: 'qwen3-coder:30b', title: 'Qwen3 Coder 30B', family: 'Coding', sizeLabel: '30B', estimatedRamGb: 22, description: 'Agentic coding model from the Qwen3-Coder family.' },
  { name: 'codellama:7b', title: 'Code Llama 7B', family: 'Coding', sizeLabel: '7B', estimatedRamGb: 5, description: 'Classic code generation and discussion model.' },
  { name: 'codellama:13b', title: 'Code Llama 13B', family: 'Coding', sizeLabel: '13B', estimatedRamGb: 9, description: 'Larger Code Llama variant for local coding tasks.' },
  { name: 'codellama:34b', title: 'Code Llama 34B', family: 'Coding', sizeLabel: '34B', estimatedRamGb: 23, description: 'Large Code Llama variant for high-memory systems.' },
  { name: 'deepseek-coder:1.3b', title: 'DeepSeek Coder 1.3B', family: 'Coding', sizeLabel: '1.3B', estimatedRamGb: 2, description: 'Small code-specialized model.' },
  { name: 'deepseek-coder:6.7b', title: 'DeepSeek Coder 6.7B', family: 'Coding', sizeLabel: '6.7B', estimatedRamGb: 5, description: 'Capable code model with practical memory use.' },
  { name: 'deepseek-coder:33b', title: 'DeepSeek Coder 33B', family: 'Coding', sizeLabel: '33B', estimatedRamGb: 23, description: 'Large DeepSeek Coder variant for high-memory systems.' },
  { name: 'deepseek-coder-v2:16b', title: 'DeepSeek Coder V2 16B', family: 'Coding', sizeLabel: '16B', estimatedRamGb: 12, description: 'MoE code model with strong coding performance.' },
  { name: 'codegemma:2b', title: 'CodeGemma 2B', family: 'Coding', sizeLabel: '2B', estimatedRamGb: 3, description: 'Lightweight code completion and generation model.' },
  { name: 'codegemma:7b', title: 'CodeGemma 7B', family: 'Coding', sizeLabel: '7B', estimatedRamGb: 5, description: 'CodeGemma for code generation and instruction following.' },
  { name: 'codestral:22b', title: 'Codestral 22B', family: 'Coding', sizeLabel: '22B', estimatedRamGb: 15, description: 'Coding model for generation, repair, and reasoning.' },
  { name: 'starcoder2:3b', title: 'StarCoder2 3B', family: 'Coding', sizeLabel: '3B', estimatedRamGb: 3, description: 'Small code model trained across many languages.' },
  { name: 'starcoder2:7b', title: 'StarCoder2 7B', family: 'Coding', sizeLabel: '7B', estimatedRamGb: 5, description: 'Mid-size code model for multilingual coding.' },
  { name: 'starcoder2:15b', title: 'StarCoder2 15B', family: 'Coding', sizeLabel: '15B', estimatedRamGb: 11, description: 'Larger StarCoder2 model for code generation.' },
  { name: 'codeqwen:7b', title: 'CodeQwen 7B', family: 'Coding', sizeLabel: '7B', estimatedRamGb: 5, description: 'Code-specific Qwen model.' },
  { name: 'sqlcoder:7b', title: 'SQLCoder 7B', family: 'Coding', sizeLabel: '7B', estimatedRamGb: 5, description: 'Specialized SQL generation model.' },
  { name: 'sqlcoder:15b', title: 'SQLCoder 15B', family: 'Coding', sizeLabel: '15B', estimatedRamGb: 11, description: 'Larger SQL generation model.' },
  { name: 'granite-code:8b', title: 'Granite Code 8B', family: 'Coding', sizeLabel: '8B', estimatedRamGb: 6, description: 'IBM Granite code model for code intelligence.' },
  { name: 'granite-code:20b', title: 'Granite Code 20B', family: 'Coding', sizeLabel: '20B', estimatedRamGb: 14, description: 'Larger Granite code model for high-memory machines.' },

  // Reasoning / math
  { name: 'deepseek-r1:1.5b', title: 'DeepSeek R1 1.5B', family: 'Reasoning', sizeLabel: '1.5B', estimatedRamGb: 2, description: 'Tiny reasoning model for quick local experiments.' },
  { name: 'deepseek-r1:7b', title: 'DeepSeek R1 7B', family: 'Reasoning', sizeLabel: '7B', estimatedRamGb: 5, description: 'Reasoning model with modest memory needs.' },
  { name: 'deepseek-r1:14b', title: 'DeepSeek R1 14B', family: 'Reasoning', sizeLabel: '14B', estimatedRamGb: 10, description: 'Mid-size reasoning model.' },
  { name: 'deepseek-r1:32b', title: 'DeepSeek R1 32B', family: 'Reasoning', sizeLabel: '32B', estimatedRamGb: 23, description: 'Large reasoning model for high-memory machines.' },
  { name: 'phi4', title: 'Phi 4', family: 'Reasoning', sizeLabel: '14B', estimatedRamGb: 10, description: 'Microsoft reasoning-oriented local model.' },
  { name: 'wizard-math:7b', title: 'WizardMath 7B', family: 'Reasoning', sizeLabel: '7B', estimatedRamGb: 5, description: 'Math-specialized model for local problem solving.' },
  { name: 'wizard-math:13b', title: 'WizardMath 13B', family: 'Reasoning', sizeLabel: '13B', estimatedRamGb: 9, description: 'Larger math-specialized model.' },
  { name: 'mathstral:7b', title: 'Mathstral 7B', family: 'Reasoning', sizeLabel: '7B', estimatedRamGb: 5, description: 'Mistral-family model tuned for math reasoning.' },
];

export function bytesToGb(bytes = 0) {
  return bytes / (1024 ** 3);
}

export function localModelBudgetGb(memory) {
  const totalGb = bytesToGb(memory?.total || 0);
  if (!totalGb) return 12;
  return Math.max(4, Math.floor(totalGb * 0.78));
}

export function stretchModelBudgetGb(memory) {
  const totalGb = bytesToGb(memory?.total || 0);
  if (!totalGb) return 16;
  return Math.max(6, Math.floor(totalGb * 0.92));
}

// Every curated model with a fit classification — nothing is silently hidden.
// A hard budget cutoff used to drop 27B+ models entirely (and when memory
// detection failed, the tiny fallback budget hid everything above ~16 GB with
// no explanation). fit: 'comfortable' | 'stretch' | 'over'.
export function recommendedOllamaModels(memory, installedModels = []) {
  const comfortableGb = localModelBudgetGb(memory);
  const stretchGb = stretchModelBudgetGb(memory);
  const installed = new Set((installedModels || []).map(m => String(m.name || m).replace(/^ollama\//, '')));
  return OLLAMA_RECOMMENDATIONS
    .map(model => {
      const fit = model.estimatedRamGb <= comfortableGb ? 'comfortable'
        : model.estimatedRamGb <= stretchGb ? 'stretch'
        : 'over';
      return {
        ...model,
        fit,
        installed: installed.has(model.name),
        fitReason: `Estimated ${model.estimatedRamGb} GB RAM; comfortable budget ${comfortableGb} GB, stretch budget ${stretchGb} GB`,
      };
    })
    .sort((a, b) => {
      if (a.installed !== b.installed) return a.installed ? 1 : -1;
      const fitRank = { comfortable: 0, stretch: 1, over: 2 };
      if (a.fit !== b.fit) return fitRank[a.fit] - fitRank[b.fit];
      if (a.family !== b.family) return a.family.localeCompare(b.family);
      return a.estimatedRamGb - b.estimatedRamGb;
    });
}

export const RECOMMENDATION_FAMILIES = ['All', ...new Set(OLLAMA_RECOMMENDATIONS.map(m => m.family))];

// Search + family filter + sort for the recommendations grid.
// sort: 'fit' (default) | 'size-asc' | 'size-desc' | 'name'
export function filterRecommendations(recs, { query = '', family = 'All', sort = 'fit' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  let out = (recs || []).filter(m =>
    (family === 'All' || m.family === family)
    && (!q || `${m.name} ${m.title} ${m.description}`.toLowerCase().includes(q)));
  if (sort === 'size-asc') out = [...out].sort((a, b) => a.estimatedRamGb - b.estimatedRamGb);
  else if (sort === 'size-desc') out = [...out].sort((a, b) => b.estimatedRamGb - a.estimatedRamGb);
  else if (sort === 'name') out = [...out].sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
