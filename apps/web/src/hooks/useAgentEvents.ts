import { useEffect, useRef } from 'react';
import type { AdeEvent, AgentActivity, AgentRunInfo, ClaudeUsage } from '@ade/shared';

interface Handlers {
  /** Cualquier cambio de agentes (agrupado en ráfagas). */
  onAnyChange: () => void;
  /** Un agente pasó de trabajar a esperar input (el volcado inicial no avisa). */
  onWaiting: (run: AgentRunInfo) => void;
  /** Nuevo dato de uso de la suscripción de Claude. */
  onUsage: (usage: ClaudeUsage) => void;
}

/** Escucha GET /api/events: estado de los agentes y uso de la suscripción. */
export function useAgentEvents(h: Handlers) {
  const handlers = useRef(h);
  handlers.current = h;

  useEffect(() => {
    const previous = new Map<string, AgentActivity | null>();
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const es = new EventSource('/api/events');

    es.addEventListener('usage', (e) => {
      const ev = JSON.parse((e as MessageEvent<string>).data) as AdeEvent;
      if (ev.type === 'usage') handlers.current.onUsage(ev.usage);
    });

    es.addEventListener('agent', (e) => {
      const ev = JSON.parse((e as MessageEvent<string>).data) as AdeEvent;
      if (ev.type !== 'agent') return;
      const { run } = ev;
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
