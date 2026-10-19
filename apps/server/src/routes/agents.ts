import type { FastifyPluginAsync } from 'fastify';
import type { AgentStreamEvent, StartAgentInput } from '@ade/shared';
import type { AgentProcessManager } from '../services/AgentProcessManager.js';
import type { GitWorktreeService } from '../services/GitWorktreeService.js';

export interface AgentRoutesDeps {
  git: GitWorktreeService;
  agents: AgentProcessManager;
  /** Intervalo de comentarios keep-alive en SSE (proxies cierran conexiones inactivas). */
  heartbeatMs?: number;
}

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const dimension = { type: 'integer', minimum: 2, maximum: 1000 } as const;

export const agentRoutes: FastifyPluginAsync<AgentRoutesDeps> = async (app, { git, agents, heartbeatMs = 15000 }) => {
  app.get('/presets', async () => agents.listPresets());

  app.get<{ Querystring: { worktreeId?: string } }>(
    '/',
    { schema: { querystring: { type: 'object', properties: { worktreeId: { type: 'string' } } } } },
    async (req) => agents.list({ worktreeId: req.query.worktreeId }),
  );

  app.post<{ Body: StartAgentInput }>(
    '/',
    {
      schema: {
        body: {
          type: 'object',
          required: ['worktreeId', 'preset'],
          additionalProperties: false,
          properties: {
            worktreeId: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$' },
            preset: { type: 'string', minLength: 1, maxLength: 64 },
            prompt: { type: 'string', maxLength: 100_000 },
            cols: dimension,
            rows: dimension,
          },
        },
      },
    },
    async (req, reply) => {
      // El cwd sale siempre del servicio git, nunca del cliente.
      const wt = await git.get(req.body.worktreeId);
      const run = agents.start({ ...req.body, worktreeId: wt.id, cwd: wt.path });
      return reply.status(201).send(run);
    },
  );

  app.get<{ Params: { id: string } }>('/:id', { schema: { params: idParams } }, async (req) =>
    agents.get(req.params.id),
  );

  app.post<{ Params: { id: string }; Body: { data: string } }>(
    '/:id/input',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['data'],
          properties: { data: { type: 'string', maxLength: 1_000_000 } },
        },
      },
    },
    async (req, reply) => {
      agents.write(req.params.id, req.body.data);
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string }; Body: { cols: number; rows: number } }>(
    '/:id/resize',
    {
      schema: {
        params: idParams,
        body: { type: 'object', required: ['cols', 'rows'], properties: { cols: dimension, rows: dimension } },
      },
    },
    async (req, reply) => {
      agents.resize(req.params.id, req.body.cols, req.body.rows);
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string } }>('/:id/stop', { schema: { params: idParams } }, async (req) =>
    agents.stop(req.params.id),
  );

  /**
   * SSE: `event: output` / `event: exit`, con `id:` = seq del chunk.
   * EventSource reenvía Last-Event-ID al reconectar y solo recibe lo que se perdió.
   * `?since=<seq>` hace lo mismo para clientes que no usan EventSource.
   */
  app.get<{ Params: { id: string }; Querystring: { since?: number } }>(
    '/:id/stream',
    {
      schema: {
        params: idParams,
        querystring: { type: 'object', properties: { since: { type: 'integer', minimum: 0 } } },
      },
    },
    async (req, reply) => {
      agents.get(req.params.id); // lanza 404 antes de abrir el stream

      const lastEventId = Number(req.headers['last-event-id']);
      const since = Number.isInteger(lastEventId) ? lastEventId : (req.query.since ?? 0);

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');

      const send = (e: AgentStreamEvent) => {
        const id = e.type === 'output' ? `id: ${e.seq}\n` : '';
        // JSON en una sola línea: la salida del PTY contiene \n y \r que romperían el framing SSE.
        res.write(`${id}event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        if (e.type === 'exit') close();
      };

      const heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
      let unsubscribe = () => {};
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        res.end();
      };
      req.raw.on('close', close);
      unsubscribe = agents.subscribe(req.params.id, since, send);
      if (closed) unsubscribe();
    },
  );
};
