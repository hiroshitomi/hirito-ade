import { buildApp } from './app.js';
import { config, defaultAgentPresets } from './config.js';
import { AgentProcessManager } from './services/AgentProcessManager.js';
import { GitWorktreeService } from './services/GitWorktreeService.js';

if (!config.repoPath) {
  // Sin esto, los agentes trabajarían sobre el propio repositorio de ADE.
  console.error('Falta ADE_REPO: indica el repositorio sobre el que trabajarán los agentes.\n' +
    '  Ejemplo: ADE_REPO=/ruta/a/tu/proyecto npm run dev');
  process.exit(1);
}

const git = await GitWorktreeService.create({ repoPath: config.repoPath, worktreesDir: config.worktreesDir });
await git.prune();
const agents = new AgentProcessManager({ presets: defaultAgentPresets });

const app = buildApp({ git, agents, allowedOrigins: config.allowedOrigins });

// Al cerrar el server, no dejar agentes huérfanos.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`${signal}: deteniendo agentes`);
    await agents.stopAll();
    await app.close();
    process.exit(0);
  });
}

// Solo loopback: nunca exponer esta API a la red.
await app.listen({ port: config.port, host: '127.0.0.1' });
