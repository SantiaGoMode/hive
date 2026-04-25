export const STARTER_MODELS = [
  { name: 'llama3.2:3b', label: 'Llama 3.2 3B', desc: 'Fast, compact, and good for everyday local chats' },
  { name: 'mistral:7b', label: 'Mistral 7B', desc: 'Balanced reasoning and writing for general work' },
  { name: 'qwen3.5:latest', label: 'Qwen 3.5', desc: 'A capable default when you want stronger reasoning' },
];

export function buildStarterAgent(modelName, overrides = {}) {
  const model = modelName || '';
  return {
    name: 'Hive Starter',
    persona_name: 'Hive Starter',
    persona_role: 'Local AI Assistant',
    description: 'A friendly starter agent for your first local Hive chat.',
    avatar_color: '#3b82f6',
    model,
    temperature: 0.7,
    max_tokens: 4096,
    context_length: 8192,
    tools: ['memory'],
    system_prompt: 'You are Hive Starter, a helpful local-first assistant. Keep answers clear, practical, and concise. Help the user learn what their local Hive setup can do, and ask a brief clarifying question when a request is ambiguous.',
    ...overrides,
  };
}
