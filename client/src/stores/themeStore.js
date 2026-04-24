import { create } from 'zustand';
import { api } from '../lib/api';

export const ACCENT_PRESETS = [
  { color: '#3b82f6', label: 'Blue'    },
  { color: '#8b5cf6', label: 'Violet'  },
  { color: '#10b981', label: 'Emerald' },
  { color: '#f59e0b', label: 'Amber'   },
  { color: '#ef4444', label: 'Red'     },
  { color: '#ec4899', label: 'Pink'    },
  { color: '#06b6d4', label: 'Cyan'    },
  { color: '#f97316', label: 'Orange'  },
];

const FONT_SIZES = { sm: '13px', md: '14px', lg: '16px' };

function applyTheme({ theme, accent, fontSize }) {
  const html = document.documentElement;
  html.classList.remove('light', 'dark');
  html.classList.add(theme);
  html.style.setProperty('--accent', accent);
  html.style.fontSize = FONT_SIZES[fontSize] || '14px';
}

export const useThemeStore = create((set, get) => ({
  theme:    'dark',
  accent:   '#3b82f6',
  fontSize: 'md',

  async load() {
    try {
      const cfg = await api.getConfig();
      const s = {
        theme:    cfg.theme        || 'dark',
        accent:   cfg.accent_color || '#3b82f6',
        fontSize: cfg.font_size    || 'md',
      };
      set(s);
      applyTheme(s);
    } catch {
      applyTheme(get());
    }
  },

  setTheme(theme) {
    set({ theme });
    applyTheme({ ...get(), theme });
    api.updateConfig({ theme }).catch(() => {});
  },

  setAccent(accent) {
    set({ accent });
    applyTheme({ ...get(), accent });
    api.updateConfig({ accent_color: accent }).catch(() => {});
  },

  setFontSize(fontSize) {
    set({ fontSize });
    applyTheme({ ...get(), fontSize });
    api.updateConfig({ font_size: fontSize }).catch(() => {});
  },
}));
