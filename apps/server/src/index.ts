import { randomBytes } from 'node:crypto';
import { buildApp } from './app.js';
import { config, defaultAgentPresets } from './config.js';
import { AgentProcessManager } from './services/AgentProcessManager.js';
import { ClaudeAuthService } from './services/ClaudeAuthService.js';
import { GitHubAuthService } from './services/GitHubAuthService.js';
import { ProjectService } from './services/ProjectService.js';
import { UsageService } from './services/UsageService.js';

const usage = new UsageService(config.usageFile);
await usage.load();
// Nuevo en cada arranque: solo los agentes lanzados por este proceso pueden reportar uso.
const usageReportToken = randomBytes(24).toString('hex');

const agents = new AgentProcessManager({
  presets: defaultAgentPresets,
  env: {
    ADE_USAGE_URL: `http://127.0.0.1:${config.port}/api/usage/report`,
    ADE_USAGE_TOKEN: usageReportToken,
  },
});
const claude = new ClaudeAuthService({ agents });

// El proyecto se elige desde la UI. ADE_REPO, si existe, lo abre al arrancar;
// si no, se reabre el último usado (o se muestra la pantalla de bienvenida).
const project = new ProjectService({ agents, stateFile: config.projectsFile, worktreesRoot: config.worktreesDir });
await project.loadState();
if (config.repoPath) {
  await project.open(config.repoPath).catch((err: Error) => {
    console.error(`No se pudo abrir ADE_REPO (${config.repoPath}): ${err.message}`);
  });
} else {
  await project.restoreLast();
}
const github = new GitHubAuthService({ agents });

const app = buildApp({
  project,
  agents,
  claude,
  github,
  usage,
  usageReportToken,
  allowedOrigins: config.allowedOrigins,
});

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
