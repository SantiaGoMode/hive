// Built-in pipeline templates. Extracted from PipelinesPage (#23).
export const PIPELINE_TEMPLATES = [
  {
    name: 'Research Brief',
    description: 'Gather evidence, critique sources, then synthesize a concise brief',
    steps: [
      {
        label: 'Research',
        agent_id: '',
        tools: ['web_search', 'memory'],
        prompt: 'Research this topic or question using current, source-backed evidence:\n\n{input}\n\nReturn 5-8 concise findings with source URLs when available. Separate facts from interpretation, call out uncertainty, and end with "Research handoff" containing the strongest findings and source list or verification gaps.',
      },
      {
        label: 'Source Critique',
        agent_id: '',
        tools: ['memory'],
        prompt: 'Critique this research handoff for weak claims, missing context, conflicting evidence, source quality, and stale or thin support:\n\n{prev}\n\nRate the evidence as strong, medium, or weak. End with "Critic handoff" containing claims safe to use and claims that need caveats.',
      },
      {
        label: 'Synthesize Brief',
        agent_id: '',
        tools: ['memory'],
        prompt: 'Create a polished research brief from the research and critique notes:\n\n{prev}\n\nInclude an executive summary, key findings, evidence notes, caveats, open questions, and source URLs or verification gaps. End with "Final brief" followed by the complete deliverable.',
      },
    ],
  },
  {
    name: 'Research → Blog Post',
    description: 'Research a topic then write a polished blog post',
    steps: [
      { label: 'Research', agent_id: '', prompt: 'Research the following topic thoroughly and summarize the key findings, facts, and insights:\n\n{input}' },
      { label: 'Write Post', agent_id: '', prompt: 'Write a well-structured, engaging blog post based on this research:\n\n{prev}\n\nMake it readable, with clear sections, a strong intro, and a conclusion.' },
    ],
  },
  {
    name: 'Summarize → Translate',
    description: 'Summarize content then translate it to Spanish',
    steps: [
      { label: 'Summarize', agent_id: '', prompt: 'Summarize the following content concisely, keeping the most important points:\n\n{input}' },
      { label: 'Translate', agent_id: '', prompt: 'Translate the following text to Spanish, preserving tone and meaning:\n\n{prev}' },
    ],
  },
  {
    name: 'Code Review → Fix',
    description: 'Review code for issues then apply fixes',
    steps: [
      { label: 'Review', agent_id: '', prompt: 'Review the following code carefully. Identify bugs, security issues, performance problems, and style improvements. Be specific:\n\n{input}' },
      { label: 'Apply Fixes', agent_id: '', prompt: 'Based on this code review:\n{prev}\n\nRewrite the original code with all the issues fixed. Provide the complete corrected code.\n\nOriginal code:\n{input}' },
    ],
  },
  {
    name: 'News Briefing',
    description: 'Search for news then write an executive summary',
    steps: [
      { label: 'Gather News', agent_id: '', prompt: 'Search for the latest news and developments about: {input}\n\nCollect the most important stories from the past 24-48 hours.' },
      { label: 'Executive Summary', agent_id: '', prompt: 'Write a concise executive briefing based on these news items:\n\n{prev}\n\nFormat: bullet points for key stories, 1-2 sentences each, most important first.' },
    ],
  },
  {
    name: 'Draft → Polish',
    description: 'Write a first draft then refine and polish it',
    steps: [
      { label: 'Draft', agent_id: '', prompt: 'Write a first draft for the following:\n\n{input}\n\nFocus on getting the content right, don\'t worry too much about polish.' },
      { label: 'Polish', agent_id: '', prompt: 'Improve and polish this draft. Fix grammar, improve flow, sharpen the language, and make it more compelling:\n\n{prev}' },
    ],
  },
  {
    name: 'Webhook → Triage',
    description: 'Triage an incoming webhook event from its distilled context, fetching raw data only if needed',
    steps: [
      {
        label: 'Triage Event',
        agent_id: '',
        tools: ['agent_tools'],
        prompt: 'You are processing an incoming webhook event. The input below is a DISTILLED context envelope — only the fields configured as relevant for this webhook, not the full payload.\n\nThe envelope has this shape:\n- `context`: the extracted fields you should work from first\n- `_event_id`: the id of the stored raw event\n- `_event_type`: the event type\n- `_projected`: true if the context was distilled, false if it is the full raw payload\n\nIf (and only if) `context` is missing a field you genuinely need, call the `get_webhook_event` tool with the `_event_id` to fetch the FULL raw payload (pass `include_headers: true` if you also need request headers). Do not fetch the raw payload otherwise — keep your context lean.\n\nTriage this event: summarize what happened, classify its importance, and state the recommended next action.\n\nEvent envelope:\n{input}',
      },
    ],
  },
];
