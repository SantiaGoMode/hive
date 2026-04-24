export function cn(...classes) {
  return classes.filter(Boolean).join(' ');
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function formatDate(ts) {
  if (!ts) return '—';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ts));
}

export function getInitials(name) {
  return (name || '?').split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

export function exportMarkdown(session) {
  const lines = [`# Session ${session.id}`, `Agent: ${session.agent_id}`, `Date: ${formatDate(session.created_at)}`, ''];
  for (const msg of session.messages) {
    const role = msg.role === 'user' ? '**You**' : '**Assistant**';
    lines.push(`${role}:\n${msg.content || ''}\n`);
  }
  return lines.join('\n');
}

export function download(content, filename, type = 'text/plain') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
