import { useState, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Bot, HardDrive, Settings, Zap, GitFork, Clock, Search, Users, Webhook, UserRound, Wrench } from 'lucide-react';
import { cn } from '../../lib/utils';
import { AgentSwitcher } from './AgentSwitcher';

const NAV = [
  { to: '/', icon: Bot, label: 'Agents' },
  { to: '/pipelines', icon: GitFork, label: 'Pipelines' },
  { to: '/schedules', icon: Clock, label: 'Schedules' },
  { to: '/colony', icon: Users, label: 'Colony' },
  { to: '/staff', icon: UserRound, label: 'Staff' },
  { to: '/skills', icon: Wrench, label: 'Skills & Tools' },
  { to: '/webhooks', icon: Webhook, label: 'Webhooks' },
  { to: '/models', icon: HardDrive, label: 'Models' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export function Layout({ children }) {
  const location = useLocation();
  const isChatPage = location.pathname.startsWith('/chat/');
  const [switcherOpen, setSwitcherOpen] = useState(false);

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSwitcherOpen(o => !o);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="flex h-screen bg-[#0f1117] text-gray-100 overflow-hidden">
      {/* Sidebar */}
      {!isChatPage && (
        <nav className="w-56 flex-shrink-0 bg-[#1a1d27] border-r border-gray-800 flex flex-col">
          {/* Logo */}
          <div className="flex items-center gap-2.5 px-4 py-5 border-b border-gray-800">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <Zap size={16} className="text-white" />
            </div>
            <div>
              <span className="font-bold text-gray-100 text-sm">Hive</span>
              <span className="text-gray-500 text-xs block -mt-0.5">AI Agent Dashboard</span>
            </div>
          </div>

          {/* Nav links */}
          <div className="flex-1 px-2 py-4 flex flex-col gap-1">
            {NAV.map(({ to, icon: Icon, label }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                className={({ isActive }) => cn(
                  'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  isActive
                    ? 'nav-active'
                    : 'text-gray-400 hover:text-gray-100 hover:bg-gray-800'
                )}
              >
                <Icon size={16} />
                {label}
              </NavLink>
            ))}
          </div>

          {/* Footer */}
          <div className="px-3 py-3 border-t border-gray-800 flex flex-col gap-2">
            <button
              onClick={() => setSwitcherOpen(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-gray-800 text-xs transition-colors w-full"
            >
              <Search size={12} />
              <span>Search agents</span>
              <kbd className="ml-auto bg-gray-800 border border-gray-700 rounded px-1 text-gray-600">⌘K</kbd>
            </button>
            <p className="text-xs text-gray-700 px-1">Hive v1.0</p>
          </div>
        </nav>
      )}

      {/* Main content */}
      <main className={cn('flex-1 overflow-y-auto', isChatPage ? 'flex flex-col' : 'p-6')}>
        {children}
      </main>

      <AgentSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} />
    </div>
  );
}
