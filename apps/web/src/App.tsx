import { healthResponseSchema, type HealthResponse } from '@issue-triage/shared';
import { useEffect, useState } from 'react';

type ApiStatus =
  { kind: 'checking' } | { kind: 'reachable'; health: HealthResponse } | { kind: 'unreachable' };

function useApiStatus(): ApiStatus {
  const [status, setStatus] = useState<ApiStatus>({ kind: 'checking' });

  useEffect(() => {
    const controller = new AbortController();
    fetch('/healthz', { signal: controller.signal })
      .then(async (response) => healthResponseSchema.parse(await response.json()))
      .then((health) => {
        setStatus({ kind: 'reachable', health });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setStatus({ kind: 'unreachable' });
        }
      });
    return () => {
      controller.abort();
    };
  }, []);

  return status;
}

function describe(status: ApiStatus): string {
  switch (status.kind) {
    case 'checking':
      return 'Checking API…';
    case 'unreachable':
      return 'API unreachable';
    case 'reachable':
      return `API ${status.health.status}`;
  }
}

export function App() {
  const status = useApiStatus();
  return (
    <main className="shell">
      <h1>Issue Triage</h1>
      <p>AI-assisted GitHub issue triage with a human in the loop.</p>
      <p>The review queue is not built yet.</p>
      <p className="status" data-kind={status.kind} role="status">
        {describe(status)}
      </p>
    </main>
  );
}
