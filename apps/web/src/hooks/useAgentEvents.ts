import { useEffect, useRef } from 'react';
import type { AdeEvent, AgentActivity, AgentRunInfo } from '@ade/shared';

/**
 * Escucha GET /api/events. Llama a `onAnyChange` (agrupado) ante cualquier cambio
 * y a `onWaiting` solo cuando un agente pasa de trabajar a esperar input; el volcado
 * inicial del servidor no dispara avisos.
 */
export function useAgentEvents(onAnyChange: () => void, onWaiting: (run: AgentRunInfo) => void) {
  const handlers = useRef({ onAnyChange, onWaiting });
  handlers.current = { onAnyChange, onWaiting };

  useEffect(() => {
    const previous = new Map<string, AgentActivity | null>();
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const es = new EventSource('/api/events');

    es.addEventListener('agent', (e) => {
      const { run } = JSON.parse((e as MessageEvent<string>).data) as AdeEvent;
      const before = previous.get(run.id);
      previous.set(run.id, run.activity);
      if (before === 'working' && run.activity === 'waiting') handlers.current.onWaiting(run);

      clearTimeout(debounce);
      debounce = setTimeout(() => handlers.current.onAnyChange(), 80);
    });

    return () => {
      clearTimeout(debounce);
      es.close();
    };
  }, []);
}
