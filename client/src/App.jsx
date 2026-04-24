import { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/ui/Layout';
import { Toaster } from './components/ui/Toast';
import { Dashboard } from './pages/Dashboard';
import { ChatPage } from './pages/ChatPage';
import { ModelsPage } from './pages/ModelsPage';
import { SettingsPage } from './pages/SettingsPage';
import { PipelinesPage } from './pages/PipelinesPage';
import SchedulesPage from './pages/SchedulesPage';
import ColonyPage from './pages/ColonyPage';
import { useThemeStore } from './stores/themeStore';

export default function App() {
  const loadTheme = useThemeStore(s => s.load);
  useEffect(() => { loadTheme(); }, []);

  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/chat/:agentId" element={<ChatPage />} />
          <Route path="/models" element={<ModelsPage />} />
          <Route path="/pipelines" element={<PipelinesPage />} />
          <Route path="/schedules" element={<SchedulesPage />} />
          <Route path="/colony" element={<ColonyPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </Layout>
      <Toaster />
    </BrowserRouter>
  );
}
