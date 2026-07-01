// Memory tool (save_memory → MEMORY.md). Split from agentTools.js (#27).
const fs = require('fs');
const path = require('path');

module.exports = {
  // ── Memory ───────────────────────────────────────────────────────────────────
  save_memory: {
    group: 'memory',
    definition: {
      type: 'function',
      function: {
        name: 'save_memory',
        description: 'Persist information to your long-term memory. Call this whenever the user shares something worth remembering across sessions. The content REPLACES the current memory — include everything you want to keep.',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Full memory content (markdown). Replaces existing memory.' },
          },
          required: ['content'],
        },
      },
    },
    async handler({ content }, { workspace }) {
      if (!workspace) return { error: 'No workspace available for this agent' };
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(path.join(workspace, 'MEMORY.md'), content.trimEnd() + '\n', 'utf8');
      return { success: true, message: 'Memory saved.' };
    },
  },

};
