import { getInitials } from '../../lib/utils';

export function AgentAvatar({ name, color = '#3b82f6', size = 40 }) {
  const initials = getInitials(name);
  return (
    <div
      className="flex items-center justify-center rounded-lg font-semibold text-white flex-shrink-0"
      style={{ background: color, width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials}
    </div>
  );
}
