import type { FastifyPluginAsync } from 'fastify';
import type { GitHubAuthService } from '../services/GitHubAuthService.js';

export const githubRoutes: FastifyPluginAsync<{ github: GitHubAuthService }> = async (app, { github }) => {
  app.get('/status', async () => github.status());
  // Devuelve la sesión de terminal del login; el cliente la muestra con /api/agents/:id/stream.
  app.post('/login', async (_req, reply) => reply.status(201).send(github.startLogin()));
  app.post('/logout', async () => github.logout());
};
