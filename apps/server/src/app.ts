import Fastify, { type FastifyServerOptions } from 'fastify';
import { AdeError } from './lib/errors.js';
import { agentRoutes } from './routes/agents.js';
import { claudeRoutes } from './routes/claude.js';
import { eventRoutes } from './routes/events.js';
import { githubRoutes } from './routes/github.js';
import { projectRoutes } from './routes/project.js';
import { usageRoutes } from './routes/usage.js';
import { worktreeRoutes } from './routes/worktrees.js';
import type { AgentProcessManager } from './services/AgentProcessManager.js';
import type { ClaudeAuthService } from './services/ClaudeAuthService.js';
import type { GitHubAuthService } from './services/GitHubAuthService.js';
import type { UsageService } from './services/UsageService.js';
import type { pickFolder } from './lib/folderPicker.js';
import type { ProjectService } from './services/ProjectService.js';

export interface AppDeps {
  project: ProjectService;
  agents: AgentProcessManager;
  claude: ClaudeAuthService;
  github: GitHubAuthService;
  usage: UsageService;
  usageReportToken: string;
  allowedOrigins: string[];
  logger?: FastifyServerOptions['logger'];
  /** Para tests: sustituye al diálogo nativo de carpetas. */
  pickFolder?: typeof pickFolder;
}

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function buildApp(deps: AppDeps) {
  const { project, agents, claude, github, usage, usageReportToken, allowedOrigins, logger = true } = deps;
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

  app.get('/api/health', async () => ({ ok: true, project: (await project.info())?.path ?? null }));
  app.register(worktreeRoutes, { prefix: '/api/worktrees', project, agents });
  app.register(agentRoutes, { prefix: '/api/agents', project, agents });
  app.register(eventRoutes, { prefix: '/api/events', agents, usage, project });
  app.register(claudeRoutes, { prefix: '/api/claude', claude });
  app.register(githubRoutes, { prefix: '/api/github', github });
  app.register(projectRoutes, { prefix: '/api/project', project, pick: deps.pickFolder });
  app.register(usageRoutes, { prefix: '/api/usage', usage, reportToken: usageReportToken });

  return app;
}
