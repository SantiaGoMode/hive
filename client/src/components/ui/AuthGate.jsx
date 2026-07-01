import { useEffect, useState } from 'react';
import { UNAUTHORIZED_EVENT, setHiveAuthToken } from '../../lib/api';

// Shown when the server rejects our credentials (401). The server generates a
// token on first boot; the user copies it from ~/.hive/auth_token (or their
// HIVE_AUTH_TOKEN env) and pastes it here once.
export function AuthGate() {
  const [locked, setLocked] = useState(false);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const onUnauthorized = () => setLocked(true);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (!locked) return null;

  const submit = async (e) => {
    e.preventDefault();
    const value = token.trim();
    if (!value) return;
    setError('');
    try {
      const res = await fetch('/api/config', { headers: { 'x-hive-auth-token': value } });
      if (!res.ok) {
        setError('That token was rejected. Check ~/.hive/auth_token on the server machine.');
        return;
      }
      setHiveAuthToken(value);
      window.location.reload();
    } catch {
      setError('Could not reach the Hive server. Is it running?');
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70" role="dialog" aria-modal="true" aria-labelledby="auth-gate-title">
      <form onSubmit={submit} className="w-full max-w-md rounded-lg border border-gray-700 bg-gray-900 p-6 shadow-xl">
        <h2 id="auth-gate-title" className="text-lg font-semibold text-gray-100">Hive auth token required</h2>
        <p className="mt-2 text-sm text-gray-400">
          This Hive server requires an auth token. It was generated on first boot —
          copy it from <code className="text-gray-300">~/.hive/auth_token</code> on the
          server machine (or your <code className="text-gray-300">HIVE_AUTH_TOKEN</code> env)
          and paste it below.
        </p>
        <label htmlFor="auth-gate-token" className="mt-4 block text-sm font-medium text-gray-300">Auth token</label>
        <input
          id="auth-gate-token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 focus:border-amber-500 focus:outline-none"
        />
        {error && <p className="mt-2 text-sm text-red-400" role="alert">{error}</p>}
        <button
          type="submit"
          className="mt-4 w-full rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50"
          disabled={!token.trim()}
        >
          Unlock
        </button>
      </form>
    </div>
  );
}
