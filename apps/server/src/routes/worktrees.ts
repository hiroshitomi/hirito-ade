import type { FastifyPluginAsync } from 'fastify';
import type { CreateWorktreeInput, MergeWorktreeRequest, WorktreeSummary } from '@ade/shared';
import { computeOverlaps } from '../services/GitWorktreeService.js';
import { AdeError, WorktreeNotFoundError } from '../lib/errors.js';
import type { AgentProcessManager } from '../services/AgentProcessManager.js';
import type { ProjectService } from '../services/ProjectService.js';

export interface WorktreeRoutesDeps {
  project: ProjectService;
  agents: AgentProcessManager;
}

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$' } },
} as const;

const branchName = { type: 'string', minLength: 1, maxLength: 200 } as const;

export const worktreeRoutes: FastifyPluginAsync<WorktreeRoutesDeps> = async (app, { project, agents }) => {
  app.post<{ Body: CreateWorktreeInput }>(
    '/create',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            repo: { type: 'string', minLength: 1, maxLength: 200 },
            name: { type: 'string', minLength: 1, maxLength: 200 },
            baseRef: branchName,
            branch: branchName,
          },
        },
      },
    },
    async (req, reply) => {
      const { repo, ...input } = req.body;
      return reply.status(201).send(await project.repo(repo).create(input));
    },
  );

  app.get('/', async (): Promise<WorktreeSummary[]> => {
      // Sin proyecto abierto, lista vacía: el dashboard muestra la pantalla de bienvenida.
      if (!project.isOpen) return [];
      const list = await project.listWithStatus();
      const overlaps = computeOverlaps(list);
      return list.map((w) => ({
        ...w,
        agentRunning: agents.isRunningFor(w.id),
        agent: agents.latestFor(w.id),
        overlaps: overlaps.get(w.id) ?? [],
      }));
  });

  app.get<{ Params: { id: string } }>('/:id', { schema: { params: idParams } }, async (req): Promise<WorktreeSummary> => {
    // Los solapes necesitan el estado de todas las tareas: se reutiliza el listado.
    const list = await project.listWithStatus();
    const wt = list.find((w) => w.id === req.params.id);
    if (!wt) throw new WorktreeNotFoundError(req.params.id);
    return {
      ...wt,
      agentRunning: agents.isRunningFor(wt.id),
      agent: agents.latestFor(wt.id),
      overlaps: computeOverlaps(list).get(wt.id) ?? [],
    };
  });

  app.get<{ Params: { id: string } }>('/:id/diff', { schema: { params: idParams } }, async (req) => {
    const { svc } = await project.find(req.params.id);
    return svc.getDiff(req.params.id);
  });

  app.delete<{ Params: { id: string }; Querystring: { force?: boolean; keepBranch?: boolean } }>(
    '/:id',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          properties: { force: { type: 'boolean' }, keepBranch: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { svc } = await project.find(id); // 404 antes de matar nada
      // Descartar implica parar al agente: no se puede borrar un directorio en uso.
      await agents.disposeWorktree(id);
      await svc.remove(id, { force: req.query.force, deleteBranch: !req.query.keepBranch });
      return reply.status(204).send();
    },
  );

  app.post<{ Body: MergeWorktreeRequest }>(
    '/merge',
    {
      schema: {
        body: {
          type: 'object',
          required: ['id'],
          additionalProperties: false,
          properties: {
            id: idParams.properties.id,
            targetBranch: branchName,
            strategy: { type: 'string', enum: ['merge', 'squash'] },
            message: { type: 'string', minLength: 1, maxLength: 5000 },
            commitPending: { type: 'boolean' },
            removeAfter: { type: 'boolean' },
          },
        },
      },
    },
    async (req) => {
      const { id, ...input } = req.body;
      // Fusionar mientras el agente escribe produciría un merge de un estado a medias.
      if (agents.isRunningFor(id)) {
        throw new AdeError('Detén el agente antes de fusionar', 'AGENT_RUNNING', 409);
      }
      const { svc } = await project.find(id);
      const result = await svc.merge(id, input);
      if (result.removed) await agents.disposeWorktree(id);
      return result;
    },
  );
};
