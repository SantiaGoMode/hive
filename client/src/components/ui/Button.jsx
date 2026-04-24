import { cn } from '../../lib/utils';

const variants = {
  primary: 'btn-accent',
  secondary: 'bg-gray-700 hover:bg-gray-600 text-gray-100',
  ghost: 'hover:bg-gray-800 text-gray-400 hover:text-gray-100',
  danger: 'bg-red-600/10 hover:bg-red-600/20 text-red-400 border border-red-600/30',
};

const sizes = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
  lg: 'px-5 py-2.5 text-base',
  icon: 'p-2',
};

export function Button({ variant = 'primary', size = 'md', className, children, ...props }) {
  return (
    <button
      className={cn(
        'inline-flex items-center gap-2 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
