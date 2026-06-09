import { cn } from '../../lib/utils';

const colors = {
  blue: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  green: 'bg-green-500/10 text-green-400 border-green-500/20',
  yellow: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  red: 'bg-red-500/10 text-red-400 border-red-500/20',
  gray: 'bg-gray-700/50 text-gray-400 border-gray-600/50',
  purple: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  teal: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
};

export function Badge({ color = 'gray', className, children, ...props }) {
  return (
    <span className={cn(
      'inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border',
      colors[color],
      className,
    )} {...props}>
      {children}
    </span>
  );
}
