import type { FastifyPluginAsync } from 'fastify';
import type { ProjectState } from '@ade/shared';
import { pickFolder } from '../lib/folderPicker.js';
import { listFolders } from '../lib/folders.js';
import type { ProjectService } from '../services/ProjectService.js';

export interface ProjectRoutesDeps {
  project: ProjectService;
  /** Inyectable para tests: el diálogo nativo no se puede abrir sin escritorio. */
  pick?: typeof pickFolder;
}

export const projectRoutes: FastifyPluginAsync<ProjectRoutesDeps> = async (app, { project, pick = pickFolder }) => {
  app.get('/', async (): Promise<ProjectState> => ({ project: await project.info(), recent: project.recent() }));

  app.post<{ Body: { path: string } }>(
    '/open',
    {
      schema: {
        body: {
          type: 'object',
          required: ['path'],
          additionalProperties: false,
          properties: { path: { type: 'string', minLength: 1, maxLength: 4096 } },
        },
      },
    },
    async (req) => project.open(req.body.path),
  );

  // Navegador de carpetas integrado: alternativa cuando no hay diálogo del sistema.
  app.get<{ Querystring: { path?: string } }>(
    '/browse',
    { schema: { querystring: { type: 'object', properties: { path: { type: 'string', maxLength: 4096 } } } } },
    async (req) => listFolders(req.query.path),
  );

  // Abre el selector de carpetas nativo en el escritorio (ADE corre en tu máquina).
  // La petición queda abierta hasta que eliges o cancelas.
  app.post('/pick', async () => pick());
};
