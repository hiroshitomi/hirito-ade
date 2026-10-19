import type { FastifyPluginAsync } from 'fastify';
import type { AdeEvent } from '@ade/shared';
import { openSse } from '../lib/sse.js';
import type { AgentProcessManager } from '../services/AgentProcessManager.js';

export interface EventRoutesDeps {
  agents: AgentProcessManager;
  heartbeatMs?: number;
}

/**
 * GET /api/events: un único stream para todo el dashboard con los cambios de
 * estado de los agentes. Así el tablero reacciona al instante (p.ej. "esperando
 * tu confirmación") sin abrir un stream de salida por agente.
 */
export const eventRoutes: FastifyPluginAsync<EventRoutesDeps> = async (app, { agents, heartbeatMs = 15000 }) => {
  app.get('/', async (req, reply) => {
    const sse = openSse(req, reply, heartbeatMs);
    const send = (e: AdeEvent) => sse.send(e.type, e);
    // Estado inicial: el cliente no necesita una petición aparte para sincronizarse.
    for (const run of agents.list()) send({ type: 'agent', run });
    sse.onClose(agents.onChange((run) => send({ type: 'agent', run })));
  });
};
