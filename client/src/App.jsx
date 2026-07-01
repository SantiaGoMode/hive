import { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/ui/Layout';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { Toaster } from './components/ui/Toast';
import { Dashboard } from './pages/Dashboard';
import { ChatPage } from './pages/ChatPage';
import { ModelsPage } from './pages/ModelsPage';
import { SettingsPage } from './pages/SettingsPage';
import { PipelinesPage } from './pages/PipelinesPage';
import SchedulesPage from './pages/SchedulesPage';
import ColonyPage from './pages/ColonyPage';
import StaffPage from './pages/StaffPage';
import SkillsPage from './pages/SkillsPage';
import WebhooksPage from './pages/WebhooksPage';
import { useThemeStore } from './stores/themeStore';

export default function App() {
  const loadTheme = useThemeStore(s => s.load);
  useEffect(() => { loadTheme(); }, []);

  return (
    <BrowserRouter>
      <Layout>
        <ErrorBoundary>
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
          </Routes>
        </ErrorBoundary>
      </Layout>
      <Toaster />
    </BrowserRouter>
  );
}
