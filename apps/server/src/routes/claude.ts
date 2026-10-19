import type { FastifyPluginAsync } from 'fastify';
import type { ClaudeAuthService } from '../services/ClaudeAuthService.js';

export const claudeRoutes: FastifyPluginAsync<{ claude: ClaudeAuthService }> = async (app, { claude }) => {
  app.get('/status', async () => claude.status());
  // Devuelve la sesión de terminal del login; el cliente la muestra con /api/agents/:id/stream.
  app.post('/login', async (_req, reply) => reply.status(201).send(claude.startLogin()));
  app.post('/logout', async () => claude.logout());
};
