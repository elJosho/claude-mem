import { useState, useEffect } from 'react';
import { API_ENDPOINTS } from '../constants/api';

/**
 * Running worker version from GET /api/version (same source as the daemon build).
 */
export function useWorkerVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(API_ENDPOINTS.VERSION)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { version?: string } | null) => {
        if (!cancelled && data?.version) {
          setVersion(data.version);
        }
      })
      .catch(() => {
        /* offline or worker down — leave null */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return version;
}
