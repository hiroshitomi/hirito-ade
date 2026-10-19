import os from 'node:os';

export interface AgentPreset {
  label: string;
  command: string;
  /** Construye los argumentos a partir del prompt opcional. */
  args: (prompt: string | undefined) => string[];
  acceptsPrompt: boolean;
  /** Variables de entorno que se eliminan antes de lanzar el proceso. */
  unsetEnv?: readonly string[];
  /** Uso interno (p.ej. el login de Claude): no se lista ni se puede lanzar por POST /api/agents. */
  hidden?: boolean;
}

/**
 * Con cualquiera de estas variables, Claude Code factura por API en vez de usar
 * la suscripción con la que iniciaste sesión. Se quitan siempre que ADE ejecuta `claude`.
 */
export const CLAUDE_API_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/** Entorno para un proceso hijo: el del servidor menos `unset`, más `extra`. */
export function childEnv(unset: readonly string[] = [], extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !unset.includes(k)) env[k] = v;
  }
  return { ...env, ...extra };
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
    unsetEnv: CLAUDE_API_ENV_VARS,
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
  // Flujo oficial de login con la suscripción (OAuth en el navegador). Lo lanza /api/claude/login.
  'claude-login': {
    label: 'Iniciar sesión en Claude',
    command: 'claude',
    args: () => ['auth', 'login', '--claudeai'],
    acceptsPrompt: false,
    unsetEnv: CLAUDE_API_ENV_VARS,
    hidden: true,
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
