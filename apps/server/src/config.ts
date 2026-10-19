import os from 'node:os';

export interface AgentPreset {
  label: string;
  command: string;
  /** Construye los argumentos a partir del prompt opcional. */
  args: (prompt: string | undefined) => string[];
  acceptsPrompt: boolean;
}

/**
 * Solo se pueden lanzar comandos definidos aquí: la API nunca recibe un binario
 * arbitrario, así una petición HTTP no puede convertirse en ejecución remota.
 */
export const defaultAgentPresets: Record<string, AgentPreset> = {
  claude: {
    label: 'Claude Code',
    command: 'claude',
    args: (prompt) => (prompt ? [prompt] : []),
    acceptsPrompt: true,
  },
  codex: {
    label: 'Codex CLI',
    command: 'codex',
    args: (prompt) => (prompt ? [prompt] : []),
    acceptsPrompt: true,
  },
  shell: {
    label: 'Shell',
    command: process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash'),
    args: () => [],
    acceptsPrompt: false,
  },
};

export const config = {
  /** Obligatorio: el repositorio sobre el que trabajan los agentes. */
  repoPath: process.env.ADE_REPO,
  worktreesDir: process.env.ADE_WORKTREES_DIR,
  port: Number(process.env.PORT ?? 4317),
  /** Orígenes del navegador autorizados (el dev server de Vite por defecto). */
  allowedOrigins: (process.env.ADE_ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
