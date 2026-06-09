const BRAVE_WEB_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

async function braveWebSearch({ query, apiKey, count = 2, fetchImpl = fetch }) {
  if (!query || !query.trim()) throw new Error('query is required');
  if (!apiKey || !apiKey.trim()) throw new Error('BRAVE_API_KEY is required');

  const url = new URL(BRAVE_WEB_SEARCH_URL);
  url.searchParams.set('q', query.trim());
  url.searchParams.set('count', String(Math.min(Math.max(Number(count) || 1, 1), 10)));

  const res = await fetchImpl(url.toString(), {
    method: 'GET',
    headers: {
      'X-Subscription-Token': apiKey.trim(),
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Brave Search failed (${res.status}): ${body}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const results = data.web?.results || [];
  return {
    query: query.trim(),
    results: results.map(r => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.description || '',
    })),
  };
}

module.exports = { BRAVE_WEB_SEARCH_URL, braveWebSearch };
