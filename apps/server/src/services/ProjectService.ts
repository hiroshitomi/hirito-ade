import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectInfo, RecentProject, WorktreeInfo, WorktreeWithStatus } from '@ade/shared';
import { AdeError, InvalidInputError, WorktreeNotFoundError } from '../lib/errors.js';
import { findChildRepos, isGitRepo } from '../lib/folders.js';
import type { AgentProcessManager } from './AgentProcessManager.js';
import { GitWorktreeService } from './GitWorktreeService.js';

export class NoProjectError extends AdeError {
  constructor() {
    super('No hay ningún proyecto abierto', 'NO_PROJECT', 409);
  }
}

export interface ProjectServiceOptions {
  agents: AgentProcessManager;
  /** Fichero con el último proyecto y los recientes (p.ej. ~/.ade/projects.json). */
  stateFile: string;
  /** Carpeta base de worktrees (una subcarpeta por repo). Por defecto, la de cada GitWorktreeService. */
  worktreesRoot?: string;
}

interface OpenProject {
  name: string;
  path: string;
  kind: 'repo' | 'workspace';
  skillsPath: string | null;
  repos: Map<string, GitWorktreeService>;
}

interface StateFile {
  last: string | null;
  recent: RecentProject[];
}

const MAX_RECENT = 10;

/**
 * Proyecto abierto en ADE. Puede ser un repo git o un **workspace**: una carpeta que
 * contiene varios repos (front, back, microservicios…) y, opcionalmente, `.claude/skills`
 * compartidas. Cada repo tiene su GitWorktreeService; las tareas se localizan por id.
 */
export class ProjectService {
  private current: OpenProject | null = null;
  private state: StateFile = { last: null, recent: [] };
  private readonly changes = new EventEmitter<{ change: [ProjectInfo | null] }>().setMaxListeners(0);

  constructor(private readonly opts: ProjectServiceOptions) {}

  async loadState(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.opts.stateFile, 'utf8')) as Partial<StateFile>;
      this.state = { last: saved.last ?? null, recent: Array.isArray(saved.recent) ? saved.recent : [] };
    } catch {
      // Primer arranque: sin recientes.
    }
  }

  /** Reabre el último proyecto usado, si sigue existiendo. */
  async restoreLast(): Promise<void> {
    if (this.state.last && existsSync(this.state.last)) {
      await this.open(this.state.last).catch(() => undefined);
    }
  }

  get isOpen(): boolean {
    return this.current !== null;
  }

  recent(): RecentProject[] {
    return this.state.recent.filter((r) => existsSync(r.path));
  }

  /**
   * Abre una carpeta. Si es (o está dentro de) un repo, proyecto de un repo. Si no,
   * se buscan repos en sus subcarpetas directas: workspace.
   */
  async open(dir: string): Promise<ProjectInfo> {
    if (this.opts.agents.list().some((r) => r.status === 'running')) {
      throw new AdeError('Detén los agentes en marcha antes de cambiar de proyecto', 'AGENTS_RUNNING', 409);
    }
    let root: string;
    try {
      root = await realpath(path.resolve(dir));
      if (!(await stat(root)).isDirectory()) throw new Error();
    } catch {
      throw new InvalidInputError(`'${dir}' no existe o no es una carpeta`);
    }

    const repos = new Map<string, GitWorktreeService>();
    let kind: OpenProject['kind'];
    if (isGitRepo(root)) {
      kind = 'repo';
      const svc = await this.createRepo(root, path.basename(root));
      repos.set(svc.name, svc);
    } else {
      const children = await findChildRepos(root);
      if (children.length === 0) {
        throw new InvalidInputError(
          `'${root}' no es un repositorio git ni contiene repositorios. Elige la carpeta de un repo o la que agrupa varios.`,
        );
      }
      kind = 'workspace';
      for (const child of children) repos.set(child.name, await this.createRepo(child.path, child.name));
    }

    const skills = path.join(root, '.claude', 'skills');
    this.current = { name: path.basename(root), path: root, kind, skillsPath: existsSync(skills) ? skills : null, repos };
    // Los agentes terminados del proyecto anterior ya no tienen worktree visible.
    this.opts.agents.forgetFinished();
    await this.remember(root, kind);

    const info = await this.info();
    this.changes.emit('change', info);
    return info!;
  }

  async info(): Promise<ProjectInfo | null> {
    const p = this.current;
    if (!p) return null;
    return {
      name: p.name,
      path: p.path,
      kind: p.kind,
      skillsPath: p.skillsPath,
      repos: await Promise.all([...p.repos.values()].map((svc) => svc.repoInfo())),
    };
  }

  /** Repo donde crear una tarea. En un workspace hay que indicarlo. */
  repo(name?: string): GitWorktreeService {
    const p = this.require();
    if (!name) {
      if (p.repos.size === 1) return p.repos.values().next().value!;
      throw new InvalidInputError(`Indica el repo: ${[...p.repos.keys()].join(', ')}`);
    }
    const svc = p.repos.get(name);
    if (!svc) throw new InvalidInputError(`El repo '${name}' no existe en el proyecto`);
    return svc;
  }

  /** Localiza una tarea por id en cualquiera de los repos. */
  async find(id: string): Promise<{ svc: GitWorktreeService; wt: WorktreeInfo }> {
    for (const svc of this.require().repos.values()) {
      try {
        return { svc, wt: await svc.get(id) };
      } catch (err) {
        if (!(err instanceof WorktreeNotFoundError)) throw err;
      }
    }
    throw new WorktreeNotFoundError(id);
  }

  async listWithStatus(): Promise<WorktreeWithStatus[]> {
    const lists = await Promise.all([...this.require().repos.values()].map((svc) => svc.listWithStatus({ managedOnly: true })));
    return lists.flat();
  }

  onChange(listener: (project: ProjectInfo | null) => void): () => void {
    this.changes.on('change', listener);
    return () => this.changes.off('change', listener);
  }

  private require(): OpenProject {
    if (!this.current) throw new NoProjectError();
    return this.current;
  }

  private async createRepo(repoPath: string, name: string): Promise<GitWorktreeService> {
    const svc = await GitWorktreeService.create({
      repoPath,
      name,
      worktreesDir: this.opts.worktreesRoot ? path.join(this.opts.worktreesRoot, name) : undefined,
    });
    await svc.prune(); // worktrees cuya carpeta se borró a mano
    return svc;
  }

  private async remember(root: string, kind: OpenProject['kind']): Promise<void> {
    const entry: RecentProject = { name: path.basename(root), path: root, kind, openedAt: new Date().toISOString() };
    this.state = {
      last: root,
      recent: [entry, ...this.state.recent.filter((r) => r.path !== root)].slice(0, MAX_RECENT),
    };
    await mkdir(path.dirname(this.opts.stateFile), { recursive: true });
    await writeFile(this.opts.stateFile, JSON.stringify(this.state, null, 2));
  }
}
