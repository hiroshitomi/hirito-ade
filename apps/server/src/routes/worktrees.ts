import type { FastifyPluginAsync } from 'fastify';
import type { CreateWorktreeInput, MergeWorktreeRequest, WorktreeSummary } from '@ade/shared';
import { AdeError } from '../lib/errors.js';
import type { AgentProcessManager } from '../services/AgentProcessManager.js';
import type { GitWorktreeService } from '../services/GitWorktreeService.js';

export interface WorktreeRoutesDeps {
  git: GitWorktreeService;
  agents: AgentProcessManager;
}

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$' } },
} as const;

const branchName = { type: 'string', minLength: 1, maxLength: 200 } as const;

export const worktreeRoutes: FastifyPluginAsync<WorktreeRoutesDeps> = async (app, { git, agents }) => {
  app.post<{ Body: CreateWorktreeInput }>(
    '/create',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            baseRef: branchName,
            branch: branchName,
          },
        },
      },
    },
    async (req, reply) => reply.status(201).send(await git.create(req.body)),
  );

  app.get<{ Querystring: { all?: boolean } }>(
    '/',
    { schema: { querystring: { type: 'object', properties: { all: { type: 'boolean' } } } } },
    async (req): Promise<WorktreeSummary[]> => {
      const list = await git.listWithStatus({ managedOnly: !req.query.all });
      return list.map((w) => ({ ...w, agentRunning: agents.isRunningFor(w.id) }));
    },
  );

  app.get<{ Params: { id: string } }>('/:id', { schema: { params: idParams } }, async (req): Promise<WorktreeSummary> => {
    const wt = await git.get(req.params.id);
    return { ...wt, status: await git.getStatus(wt.id), agentRunning: agents.isRunningFor(wt.id) };
  });

  app.get<{ Params: { id: string } }>('/:id/diff', { schema: { params: idParams } }, async (req) =>
    git.getDiff(req.params.id),
  );

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
      await git.get(id); // 404 antes de matar nada
      // Descartar implica parar al agente: no se puede borrar un directorio en uso.
      await agents.disposeWorktree(id);
      await git.remove(id, { force: req.query.force, deleteBranch: !req.query.keepBranch });
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
      const result = await git.merge(id, input);
      if (result.removed) await agents.disposeWorktree(id);
      return result;
    },
  );
};
