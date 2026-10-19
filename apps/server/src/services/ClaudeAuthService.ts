import os from 'node:os';
import { execa } from 'execa';
import type { AgentRunInfo, ClaudeAuthStatus } from '@ade/shared';
import { CLAUDE_API_ENV_VARS, childEnv } from '../config.js';
import type { AgentProcessManager } from './AgentProcessManager.js';

/** Id fijo para la sesión de login: no es un worktree, así que el tablero la ignora. */
export const CLAUDE_LOGIN_SESSION = 'claude-auth';

export interface ClaudeAuthServiceOptions {
  agents: AgentProcessManager;
  /** Binario de Claude Code (configurable para tests). */
  command?: string;
  /** Preset interno que ejecuta el login. */
  loginPreset?: string;
}

/**
 * Sesión de Claude Code de la máquina. ADE nunca toca credenciales: consulta el
 * estado con `claude auth status` y delega el login en el flujo oficial del CLI
 * (`claude auth login --claudeai`), que guarda la sesión donde Claude Code la busca.
 */
export class ClaudeAuthService {
  private readonly agents: AgentProcessManager;
  private readonly command: string;
  private readonly loginPreset: string;

  constructor(opts: ClaudeAuthServiceOptions) {
    this.agents = opts.agents;
    this.command = opts.command ?? 'claude';
    this.loginPreset = opts.loginPreset ?? 'claude-login';
  }

  async status(): Promise<ClaudeAuthStatus> {
    const ignoredEnvVars = CLAUDE_API_ENV_VARS.filter((v) => process.env[v]);
    const base: ClaudeAuthStatus = {
      installed: false,
      version: null,
      loggedIn: false,
      authMethod: null,
      usesSubscription: false,
      email: null,
      subscriptionType: null,
      orgName: null,
      ignoredEnvVars,
      error: null,
    };

    // Mismo entorno que los agentes: el estado refleja lo que ellos usarán de verdad.
    const env = childEnv(CLAUDE_API_ENV_VARS);
    const version = await execa(this.command, ['--version'], { env, extendEnv: false, reject: false, timeout: 15000 });
    if (version.failed && (version as { code?: string }).code === 'ENOENT') return base;
    const installed = { ...base, installed: true, version: version.stdout?.split(/\s+/)[0] || null };

    const res = await execa(this.command, ['auth', 'status', '--json'], {
      env,
      extendEnv: false,
      reject: false,
      timeout: 15000,
    });
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(res.stdout ?? '') as Record<string, unknown>;
    } catch {
      return { ...installed, error: (res.stderr || res.stdout || 'Respuesta inesperada de claude auth status').trim() };
    }

    const str = (...keys: string[]) => {
      for (const k of keys) if (typeof data[k] === 'string' && data[k]) return data[k] as string;
      return null;
    };
    const loggedIn = data.loggedIn === true;
    const authMethod = str('authMethod');
    // API key (de cualquier fuente) o proveedores cloud (Bedrock/Vertex) no usan la suscripción.
    const usesSubscription =
      loggedIn && authMethod !== 'api_key' && !data.apiKeySource && (data.apiProvider ?? 'firstParty') === 'firstParty';

    return {
      ...installed,
      loggedIn,
      authMethod,
      usesSubscription,
      email: str('email', 'emailAddress'),
      subscriptionType: str('subscriptionType', 'plan'),
      orgName: str('orgName', 'organizationName'),
    };
  }

  /** Abre el login oficial en un PTY; si ya hay uno en curso, devuelve ese. */
  startLogin(): AgentRunInfo {
    const running = this.agents.list({ worktreeId: CLAUDE_LOGIN_SESSION }).find((r) => r.status === 'running');
    if (running) return running;
    return this.agents.start({ worktreeId: CLAUDE_LOGIN_SESSION, cwd: os.homedir(), preset: this.loginPreset });
  }

  async logout(): Promise<ClaudeAuthStatus> {
    await execa(this.command, ['auth', 'logout'], {
      env: childEnv(CLAUDE_API_ENV_VARS),
      extendEnv: false,
      reject: false,
      timeout: 15000,
    });
    return this.status();
  }
}
