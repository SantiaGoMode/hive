import { CheckCircle, XCircle, Info, X } from 'lucide-react';
import { useToastStore } from '../../stores/toastStore';

const icons = {
  success: <CheckCircle size={16} className="text-green-400" />,
  error: <XCircle size={16} className="text-red-400" />,
  info: <Info size={16} className="text-blue-400" />,
};

const borders = {
  success: 'border-green-500/30',
  error: 'border-red-500/30',
  info: 'border-blue-500/30',
};

export function Toaster() {
  const { toasts, remove } = useToastStore();
  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map(t => (
        <div key={t.id} className={`flex items-start gap-3 bg-gray-900 border ${borders[t.type]} rounded-lg px-4 py-3 shadow-xl min-w-64 max-w-sm animate-in slide-in-from-right`}>
          {icons[t.type]}
          <span className="text-sm text-gray-200 flex-1">{t.message}</span>
          <button onClick={() => remove(t.id)} className="text-gray-500 hover:text-gray-300">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
