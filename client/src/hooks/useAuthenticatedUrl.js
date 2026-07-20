import { useEffect, useState } from 'react';
import { fetchAuthenticated } from '../lib/api';

// Browser media elements cannot attach Hive's auth header. Fetch the bytes
// explicitly and expose only a short-lived in-memory Blob URL to the element.
export function useAuthenticatedUrl(url) {
  const [objectUrl, setObjectUrl] = useState('');

  useEffect(() => {
    if (!url) {
      setObjectUrl('');
      return undefined;
    }
    const controller = new AbortController();
    let created = '';
    fetchAuthenticated(url, { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error(`Media request failed (${response.status})`);
        return response.blob();
      })
      .then(blob => {
        if (controller.signal.aborted) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      })
      .catch(() => { if (!controller.signal.aborted) setObjectUrl(''); });
    return () => {
      controller.abort();
      if (created) URL.revokeObjectURL(created);
    };
  }, [url]);

  return objectUrl;
}
