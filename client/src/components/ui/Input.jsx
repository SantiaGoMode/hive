import { useId } from 'react';
import { cn } from '../../lib/utils';

export function Input({ label, error, className, ...props }) {
  const generatedId = useId();
  const id = props.id || generatedId;
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1">
      {label && <label htmlFor={id} className="text-sm font-medium text-gray-300">{label}</label>}
      <input
        {...props}
        id={id}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? errorId : props['aria-describedby']}
        className={cn(
          'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors',
          error && 'border-red-500',
          className,
        )}
      />
      {error && <p id={errorId} className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

export function Textarea({ label, error, className, ...props }) {
  const generatedId = useId();
  const id = props.id || generatedId;
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1">
      {label && <label htmlFor={id} className="text-sm font-medium text-gray-300">{label}</label>}
      <textarea
        {...props}
        id={id}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? errorId : props['aria-describedby']}
        className={cn(
          'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors resize-none font-mono',
          error && 'border-red-500',
          className,
        )}
      />
      {error && <p id={errorId} className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

export function Select({ label, error, className, children, ...props }) {
  const generatedId = useId();
  const id = props.id || generatedId;
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1">
      {label && <label htmlFor={id} className="text-sm font-medium text-gray-300">{label}</label>}
      <select
        {...props}
        id={id}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? errorId : props['aria-describedby']}
        className={cn(
          'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors',
          className,
        )}
      >
        {children}
      </select>
      {error && <p id={errorId} className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
