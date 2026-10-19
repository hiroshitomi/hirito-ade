import os from 'node:os';
import { execa } from 'execa';
import type { AgentRunInfo, GitHubAuthStatus } from '@ade/shared';
import { childEnv } from '../config.js';
import type { AgentProcessManager } from './AgentProcessManager.js';

/** Id fijo para la sesión de login: no es un worktree, así que el tablero la ignora. */
export const GITHUB_LOGIN_SESSION = 'github-auth';
const HOST = 'github.com';

export interface GitHubAuthServiceOptions {
  agents: AgentProcessManager;
  /** Binario de GitHub CLI (configurable para tests). */
  command?: string;
  loginPreset?: string;
}

export interface GhHostEntry {
  state?: string;
  active?: boolean;
  login?: string;
  tokenSource?: string;
  gitProtocol?: string;
  error?: string;
}

/**
 * Cuenta de GitHub vía GitHub CLI (`gh`), igual que la de Claude: ADE consulta
 * `gh auth status` y delega el login en `gh auth login --web`. El token queda en
 * el almacén de `gh` (keyring), y git lo usa como credential helper.
 */
export class GitHubAuthService {
  private readonly agents: AgentProcessManager;
  private readonly command: string;
  private readonly loginPreset: string;

  constructor(opts: GitHubAuthServiceOptions) {
    this.agents = opts.agents;
    this.command = opts.command ?? 'gh';
    this.loginPreset = opts.loginPreset ?? 'gh-login';
  }

  async status(): Promise<GitHubAuthStatus> {
    const base: GitHubAuthStatus = {
      installed: false,
      version: null,
      loggedIn: false,
      login: null,
      host: HOST,
      tokenSource: null,
      gitProtocol: null,
      error: null,
    };
    const env = childEnv();
    const version = await execa(this.command, ['--version'], { env, extendEnv: false, reject: false, timeout: 15000 });
    if (version.failed && (version as { code?: string }).code === 'ENOENT') return base;
    const installed = { ...base, installed: true, version: /\d+\.\d+\.\d+/.exec(version.stdout ?? '')?.[0] ?? null };

    // Con --json, gh sale con 0 aunque haya errores de autenticación: el detalle va en cada host.
    const res = await execa(this.command, ['auth', 'status', '--hostname', HOST, '--json', 'hosts'], {
      env,
      extendEnv: false,
      reject: false,
      timeout: 20000,
    });
    let entries: GhHostEntry[];
    try {
      const data = JSON.parse(res.stdout ?? '') as { hosts?: Record<string, GhHostEntry[]> };
      entries = data.hosts?.[HOST] ?? [];
    } catch {
      // `--json` llegó en gh 2.6x; versiones de distro (p.ej. Ubuntu 24.04 trae 2.45) no lo tienen.
      const text = await execa(this.command, ['auth', 'status', '--hostname', HOST], {
        env,
        extendEnv: false,
        reject: false,
        timeout: 20000,
      });
      entries = parseTextStatus(`${text.stdout ?? ''}\n${text.stderr ?? ''}`);
    }

    const active = entries.find((e) => e.active) ?? entries[0];
    if (!active) return installed;
    return {
      ...installed,
      loggedIn: active.state === 'success',
      login: active.login || null,
      tokenSource: active.tokenSource ?? null,
      gitProtocol: active.gitProtocol ?? null,
      error: active.state === 'success' ? null : (active.error ?? 'Error de autenticación').slice(0, 300),
    };
  }

  startLogin(): AgentRunInfo {
    return this.agents.startOrReuse({ worktreeId: GITHUB_LOGIN_SESSION, cwd: os.homedir(), preset: this.loginPreset });
  }

  async logout(): Promise<GitHubAuthStatus> {
    const current = await this.status();
    // --user evita la pregunta interactiva de qué cuenta cerrar.
    const args = ['auth', 'logout', '--hostname', HOST, ...(current.login ? ['--user', current.login] : [])];
    await execa(this.command, args, { env: childEnv(), extendEnv: false, reject: false, timeout: 15000 });
    return this.status();
  }
}

/**
 * Salida en texto de `gh auth status` (versiones sin --json). Formatos conocidos:
 *   ✓ Logged in to github.com account USER (keyring)      ← gh ≥ 2.40
 *   ✓ Logged in to github.com as USER (/ruta/hosts.yml)   ← anteriores
 */
export function parseTextStatus(text: string): GhHostEntry[] {
  const m = /Logged in to \S+ (?:account|as) (\S+) \(([^)]+)\)/.exec(text);
  if (m) return [{ state: 'success', active: true, login: m[1], tokenSource: m[2] }];
  const failed = /Failed to log in to \S+ (?:account|as|using token) ?(\S*)/.exec(text);
  if (failed) return [{ state: 'error', active: true, login: failed[1] || undefined, error: text.trim().slice(0, 300) }];
  return [];
}
