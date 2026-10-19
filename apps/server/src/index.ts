import { buildApp } from './app.js';
import { config, defaultAgentPresets } from './config.js';
import { AgentProcessManager } from './services/AgentProcessManager.js';
import { randomBytes } from 'node:crypto';
import { ClaudeAuthService } from './services/ClaudeAuthService.js';
import { GitHubAuthService } from './services/GitHubAuthService.js';
import { UsageService } from './services/UsageService.js';
import { GitWorktreeService } from './services/GitWorktreeService.js';

if (!config.repoPath) {
  // Sin esto, los agentes trabajarían sobre el propio repositorio de ADE.
  console.error('Falta ADE_REPO: indica el repositorio sobre el que trabajarán los agentes.\n' +
    '  Ejemplo: ADE_REPO=/ruta/a/tu/proyecto npm run dev');
  process.exit(1);
}

const git = await GitWorktreeService.create({ repoPath: config.repoPath, worktreesDir: config.worktreesDir });
await git.prune();

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
const github = new GitHubAuthService({ agents });

const app = buildApp({
  git,
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
