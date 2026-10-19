import type { FastifyPluginAsync } from 'fastify';
import type { GitWorktreeService } from '../services/GitWorktreeService.js';

export const projectRoutes: FastifyPluginAsync<{ git: GitWorktreeService }> = async (app, { git }) => {
  app.get('/', async () => git.projectInfo());
};
