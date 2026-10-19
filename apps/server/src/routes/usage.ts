import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { AdeError } from '../lib/errors.js';
import type { RawWindow, UsageService } from '../services/UsageService.js';

export interface UsageRoutesDeps {
  usage: UsageService;
  /** Secreto que solo conocen los agentes lanzados por este servidor (variable ADE_USAGE_TOKEN). */
  reportToken: string;
}

const rawWindow = {
  type: ['object', 'null'],
  required: ['used_percentage', 'resets_at'],
  properties: { used_percentage: { type: 'number' }, resets_at: { type: 'number' } },
} as const;

export const usageRoutes: FastifyPluginAsync<UsageRoutesDeps> = async (app, { usage, reportToken }) => {
  app.get('/', async () => usage.get());

  // La llama la status line de cada agente de Claude Code (bin/ade-statusline.mjs).
  app.post<{ Body: { fiveHour: RawWindow | null; sevenDay: RawWindow | null } }>(
    '/report',
    {
      schema: {
        body: {
          type: 'object',
          required: ['fiveHour', 'sevenDay'],
          additionalProperties: false,
          properties: { fiveHour: rawWindow, sevenDay: rawWindow },
        },
      },
    },
    async (req) => {
      const given = Buffer.from(String(req.headers['x-ade-token'] ?? ''));
      const expected = Buffer.from(reportToken);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        throw new AdeError('Token de reporte inválido', 'FORBIDDEN', 403);
      }
      return usage.report(req.body);
    },
  );
};
