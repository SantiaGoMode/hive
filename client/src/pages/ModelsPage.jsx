import { ModelBrowser } from '../components/models/ModelBrowser';

export function ModelsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-100">Models</h1>
        <p className="text-sm text-gray-500 mt-0.5">Manage your local Ollama models</p>
      </div>
      <ModelBrowser />
    </div>
  );
}
