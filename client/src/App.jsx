import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { Layout } from './components/ui/Layout';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { Toaster } from './components/ui/Toast';
import { AuthGate } from './components/ui/AuthGate';
import { useThemeStore } from './stores/themeStore';
import { api } from './lib/api';
import { needsSetup } from './lib/setupWizard';

const lazyNamed = (loader, exportName) => lazy(() => (
  loader().then(module => ({ default: module[exportName] }))
));

const Dashboard = lazyNamed(() => import('./pages/Dashboard'), 'Dashboard');
const ChatPage = lazyNamed(() => import('./pages/ChatPage'), 'ChatPage');
const ModelsPage = lazyNamed(() => import('./pages/ModelsPage'), 'ModelsPage');
const PipelinesPage = lazyNamed(() => import('./pages/PipelinesPage'), 'PipelinesPage');
const SettingsPage = lazyNamed(() => import('./pages/SettingsPage'), 'SettingsPage');
const SchedulesPage = lazy(() => import('./pages/SchedulesPage'));
const ColonyPage = lazy(() => import('./pages/ColonyPage'));
const StaffPage = lazy(() => import('./pages/StaffPage'));
const SkillsPage = lazy(() => import('./pages/SkillsPage'));
const WebhooksPage = lazy(() => import('./pages/WebhooksPage'));
const SetupPage = lazyNamed(() => import('./pages/SetupPage'), 'SetupPage');

// Fresh installs (wizard never completed, zero agents) get routed to /setup
// once per app load. Errors are ignored — an unauthenticated fetch just means
// the AuthGate is about to take over.
function FirstRunRedirect() {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    if (location.pathname === '/setup') return;
    let cancelled = false;
    Promise.all([api.getAgents(), api.getSetupStatus()])
      .then(([agents, setupStatus]) => {
        if (!cancelled && needsSetup({ setupStatus, agents })) {
          navigate('/setup', { replace: true });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function RouteFallback() {
  return (
    <div className="flex items-center justify-center h-64 text-gray-500 text-sm">
      Loading...
    </div>
  );
}

export default function App() {
  const loadTheme = useThemeStore(s => s.load);
  useEffect(() => { loadTheme(); }, [loadTheme]);

  return (
    <BrowserRouter>
      <Layout>
        <ErrorBoundary>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/chat/:agentId" element={<ChatPage />} />
              <Route path="/models" element={<ModelsPage />} />
              <Route path="/pipelines" element={<PipelinesPage />} />
              <Route path="/schedules" element={<SchedulesPage />} />
              {/* /colony, /colony/:teamId, /colony/:teamId/run/:runId — one mounted
                  component so live SSE streams survive internal navigation. */}
              <Route path="/colony/*" element={<ColonyPage />} />
              <Route path="/staff" element={<StaffPage />} />
              <Route path="/skills" element={<SkillsPage />} />
              <Route path="/webhooks" element={<WebhooksPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/setup" element={<SetupPage />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </Layout>
      <FirstRunRedirect />
      <Toaster />
      <AuthGate />
    </BrowserRouter>
  );
}
