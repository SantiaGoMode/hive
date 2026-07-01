// Web tools (web_search/web_fetch via the Ollama web endpoints). Split from agentTools.js (#27).

module.exports = {
  // ── Web search ───────────────────────────────────────────────────────────────
  web_search: {
    group: 'web_search',
    definition: {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web for current information. Use for news, facts, recent events, or anything that may have changed since your training cutoff.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'The search query' } },
          required: ['query'],
        },
      },
    },
    async handler({ query }, { ollamaUrl }) {
      const res = await fetch(`${ollamaUrl}/api/experimental/web_search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), max_results: 5 }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { error: `Web search failed (${res.status}): ${body}` };
      }
      const data = await res.json();
      if (!data.results?.length) return { results: [], message: 'No results found.' };
      return {
        results: data.results.map(r => ({
          title:   r.title,
          url:     r.url,
          snippet: r.content?.slice(0, 400) || '',
        })),
      };
    },
  },

  web_fetch: {
    group: 'web_search',
    definition: {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: 'Fetch and read the full content of a specific web page by URL.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: 'The URL to fetch' } },
          required: ['url'],
        },
      },
    },
    async handler({ url }, { ollamaUrl }) {
      const res = await fetch(`${ollamaUrl}/api/experimental/web_fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { error: `Web fetch failed (${res.status}): ${body}` };
      }
      const data = await res.json();
      return { title: data.title || '', content: data.content || '(no content)', url };
    },
  },
};
