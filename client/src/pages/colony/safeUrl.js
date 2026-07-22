// Links in deliverables, artifacts, and parsed goal text are LLM-controlled.
// Only render http(s) URLs as anchors in the Electron application origin.
export const isSafeUrl = (url) => /^https?:\/\//i.test(String(url || ''));
