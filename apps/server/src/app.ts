import Fastify, { type FastifyServerOptions } from 'fastify';
import { AdeError } from './lib/errors.js';
import { agentRoutes } from './routes/agents.js';
import { eventRoutes } from './routes/events.js';
import { worktreeRoutes } from './routes/worktrees.js';
import type { AgentProcessManager } from './services/AgentProcessManager.js';
import type { GitWorktreeService } from './services/GitWorktreeService.js';

export interface AppDeps {
  git: GitWorktreeService;
  agents: AgentProcessManager;
  allowedOrigins: string[];
  logger?: FastifyServerOptions['logger'];
}

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function buildApp({ git, agents, allowedOrigins, logger = true }: AppDeps) {
  // removeAdditional: false → campos desconocidos dan 400 en vez de ignorarse en silencio.
  const app = Fastify({ logger, ajv: { customOptions: { removeAdditional: false } } });

  // Esta API lanza procesos en tu máquina. Cualquier web abierta en el navegador
  // podría hacer peticiones a localhost, así que exigimos Host local (contra DNS
  // rebinding) y, si hay cabecera Origin, que esté en la lista blanca (contra CSRF).
  app.addHook('onRequest', async (req, reply) => {
    if (!LOCAL_HOST_RE.test(req.headers.host ?? '')) {
      return reply.status(403).send({ error: 'FORBIDDEN_HOST', message: 'Host no permitido' });
    }
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) {
      return reply.status(403).send({ error: 'FORBIDDEN_ORIGIN', message: `Origen no permitido: ${origin}` });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AdeError) {
      if (err.statusCode >= 500) req.log.error(err);
      return reply.status(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    if ((err as { validation?: unknown }).validation) {
      return reply.status(400).send({ error: 'INVALID_INPUT', message: (err as Error).message });
    }
    req.log.error(err);
    return reply.status(500).send({ error: 'INTERNAL', message: 'Error interno' });
  });

  app.get('/api/health', async () => ({ ok: true, repoRoot: git.repoRoot, worktreesDir: git.worktreesDir }));
  app.register(worktreeRoutes, { prefix: '/api/worktrees', git, agents });
  app.register(agentRoutes, { prefix: '/api/agents', git, agents });
  app.register(eventRoutes, { prefix: '/api/events', agents });

  return app;
}
