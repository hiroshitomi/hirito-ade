import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type {
  CreateWorktreeInput,
  FileChange,
  FileChangeStatus,
  MergeResult,
  MergeWorktreeInput,
  WorktreeDiff,
  WorktreeInfo,
  WorktreeStatus,
  WorktreeWithStatus,
} from '@ade/shared';
import {
  AdeError,
  BranchExistsError,
  DirtyWorktreeError,
  GitCommandError,
  InvalidInputError,
  MergeConflictError,
  WorktreeNotFoundError,
} from '../lib/errors.js';
import { Mutex } from '../lib/mutex.js';

export interface GitWorktreeServiceOptions {
  /** Cualquier ruta dentro del repositorio a orquestar. */
  repoPath: string;
  /**
   * Dónde se crean los worktrees. Por defecto `~/.ade/worktrees/<repo>-<hash>`:
   * fuera del repo para que watchers, linters o tsc del checkout principal no
   * escaneen copias del proyecto.
   */
  worktreesDir?: string;
  /** Prefijo para ramas autogeneradas. */
  branchPrefix?: string;
  /** Rama principal. Por defecto: `main` o `master`, la que exista. */
  defaultBranch?: string;
  /** Identidad usada en commits automáticos si el repo no tiene user.name/email. */
  committer?: { name: string; email: string };
}

interface GitRunOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Códigos de salida distintos de 0 que no deben lanzar. */
  allowExitCodes?: number[];
}

const MIN_GIT_VERSION = [2, 38] as const; // `merge-tree --write-tree`
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BASE_CONFIG_KEY = 'adeBase';

// Entorno determinista: salida parseable y git nunca bloquea pidiendo input.
const GIT_ENV = {
  LC_ALL: 'C',
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  GIT_MERGE_AUTOEDIT: 'no',
};

export class GitWorktreeService {
  private readonly lock = new Mutex();

  private constructor(
    readonly repoRoot: string,
    readonly worktreesDir: string,
    private readonly branchPrefix: string,
    private readonly defaultBranchOverride: string | undefined,
    private readonly committer: { name: string; email: string },
  ) {}

  /** Factory asíncrona: valida git y resuelve rutas canónicas antes de construir. */
  static async create(opts: GitWorktreeServiceOptions): Promise<GitWorktreeService> {
    await assertGitVersion();

    const run = (args: string[]) => execa('git', args, { cwd: opts.repoPath, env: GIT_ENV, reject: false });
    // --git-common-dir apunta al .git del repo principal aunque repoPath sea un worktree secundario.
    const common = await run(['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (common.exitCode !== 0) throw new InvalidInputError(`'${opts.repoPath}' no es un repositorio git`);
    const bare = await run(['rev-parse', '--is-bare-repository']);
    if (bare.stdout === 'true') throw new InvalidInputError('Los repositorios bare no están soportados');

    const repoRoot = await realpath(path.dirname(common.stdout));
    const hash = createHash('sha1').update(repoRoot).digest('hex').slice(0, 8);
    const worktreesDir =
      opts.worktreesDir ?? path.join(os.homedir(), '.ade', 'worktrees', `${path.basename(repoRoot)}-${hash}`);
    await mkdir(worktreesDir, { recursive: true });

    return new GitWorktreeService(
      repoRoot,
      await realpath(worktreesDir), // git reporta rutas reales (p.ej. /private/var en macOS)
      opts.branchPrefix ?? 'ade/',
      opts.defaultBranch,
      opts.committer ?? { name: 'ADE Agent', email: 'ade-agent@localhost' },
    );
  }

  // ---------------------------------------------------------------------------
  // Lectura
  // ---------------------------------------------------------------------------

  /** Lista worktrees. Git es la fuente de verdad: sobrevive a reinicios del server. */
  async list(opts: { managedOnly?: boolean } = {}): Promise<WorktreeInfo[]> {
    const { stdout } = await this.git(['worktree', 'list', '--porcelain', '-z']);
    const records = parseWorktreePorcelain(stdout);
    const bases = await this.readBaseBranches();

    const all = records.map((r, i): WorktreeInfo => {
      const managed = isInside(this.worktreesDir, r.path);
      return {
        id: managed ? path.basename(r.path) : i === 0 ? 'main' : `external-${i}`,
        path: r.path,
        branch: r.branch,
        head: r.head,
        baseBranch: r.branch ? (bases.get(r.branch) ?? null) : null,
        isMain: i === 0,
        managed,
        locked: r.locked,
        prunable: r.prunable,
      };
    });
    return opts.managedOnly ? all.filter((w) => w.managed) : all;
  }

  async listWithStatus(opts: { managedOnly?: boolean } = {}): Promise<WorktreeWithStatus[]> {
    const list = await this.list(opts);
    return Promise.all(
      list.map(async (w) => ({ ...w, status: w.prunable ? null : await this.status(w).catch(() => null) })),
    );
  }

  async get(id: string): Promise<WorktreeInfo> {
    assertValidId(id);
    const wt = (await this.list({ managedOnly: true })).find((w) => w.id === id);
    if (!wt) throw new WorktreeNotFoundError(id);
    return wt;
  }

  async getStatus(id: string): Promise<WorktreeStatus> {
    return this.status(await this.get(id));
  }

  /**
   * Diff completo del trabajo del agente respecto al merge-base con su rama base:
   * commits + cambios sin commitear + ficheros nuevos no trackeados.
   *
   * Usa un índice temporal (GIT_INDEX_FILE) para incluir los untracked sin
   * tocar el índice real del worktree, en el que el agente puede estar trabajando.
   */
  async getDiff(id: string): Promise<WorktreeDiff> {
    const wt = await this.get(id);
    const baseBranch = this.requireBase(wt);
    const { stdout: mergeBase } = await this.git(['merge-base', baseBranch, 'HEAD'], { cwd: wt.path });

    const tmp = await mkdtemp(path.join(os.tmpdir(), 'ade-idx-'));
    try {
      const run = { cwd: wt.path, env: { GIT_INDEX_FILE: path.join(tmp, 'index') } };
      await this.git(['read-tree', 'HEAD'], run);
      await this.git(['add', '-A'], run); // respeta .gitignore
      const diffArgs = ['diff', '--cached', '--no-color', '--no-renames', '--no-ext-diff', mergeBase];
      const [patch, numstat, nameStatus] = await Promise.all([
        this.git(diffArgs, run),
        this.git([...diffArgs, '--numstat', '-z'], run),
        this.git([...diffArgs, '--name-status', '-z'], run),
      ]);
      return {
        baseBranch,
        mergeBase,
        files: parseFileChanges(nameStatus.stdout, numstat.stdout),
        patch: patch.stdout,
      };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Escritura (serializada con el mutex)
  // ---------------------------------------------------------------------------

  async create(input: CreateWorktreeInput): Promise<WorktreeInfo> {
    const slug = slugify(input.name);
    if (!slug) throw new InvalidInputError('El nombre de la tarea debe contener caracteres alfanuméricos');
    // Sufijo aleatorio: dos tareas con el mismo nombre no colisionan.
    const id = `${slug}-${randomBytes(3).toString('hex')}`;
    const branch = input.branch ?? `${this.branchPrefix}${id}`;

    return this.lock.run(async () => {
      const baseRef = input.baseRef ?? (await this.defaultBranch());
      await this.assertBranchName(branch);
      if (await this.refExists(`refs/heads/${branch}`)) throw new BranchExistsError(branch);
      if (!(await this.refExists(`${baseRef}^{commit}`))) {
        throw new InvalidInputError(`La referencia base '${baseRef}' no existe`);
      }

      const wtPath = path.join(this.worktreesDir, id);
      await this.git(['worktree', 'add', '-b', branch, wtPath, baseRef]);
      // Solo guardamos la base si es una rama: es contra lo que se fusionará después.
      if (await this.refExists(`refs/heads/${baseRef}`)) {
        await this.git(['config', '--local', `branch.${branch}.${BASE_CONFIG_KEY}`, baseRef]);
      }
      return this.get(id);
    });
  }

  /** Commitea todo lo pendiente en el worktree. Devuelve el SHA o null si no había cambios. */
  async commitAll(id: string, message: string): Promise<string | null> {
    return this.lock.run(async () => this.commitAllUnlocked(await this.get(id), message));
  }

  async remove(id: string, opts: { force?: boolean; deleteBranch?: boolean } = {}): Promise<void> {
    return this.lock.run(async () => this.removeUnlocked(await this.get(id), opts));
  }

  /**
   * Fusiona la rama del worktree en la rama destino.
   *
   * - Si la rama destino está checkouteada en algún worktree (caso típico: `main`
   *   en el repo principal), se hace `git merge` allí, exigiendo que esté limpio.
   * - Si no lo está, se fusiona sin working tree con `merge-tree --write-tree` +
   *   `commit-tree` + `update-ref` atómico; no toca ningún checkout del usuario.
   *
   * Ante conflictos no se deja nada a medias: se aborta y se lanza MergeConflictError.
   */
  async merge(id: string, input: MergeWorktreeInput = {}): Promise<MergeResult> {
    return this.lock.run(async () => {
      const wt = await this.get(id);
      if (!wt.branch) throw new InvalidInputError(`El worktree '${id}' está en detached HEAD`);
      const source = wt.branch;
      const target = input.targetBranch ?? this.requireBase(wt);
      const strategy = input.strategy ?? 'merge';
      const removeAfter = input.removeAfter ?? true;

      if (target === source) throw new InvalidInputError('La rama destino no puede ser la del propio worktree');
      if (!(await this.refExists(`refs/heads/${target}`))) {
        throw new InvalidInputError(`La rama destino '${target}' no existe`);
      }

      if (await this.isDirty(wt.path)) {
        if (input.commitPending === false) throw new DirtyWorktreeError(wt.path);
        await this.commitAllUnlocked(wt, `ade: cambios pendientes de ${id}`);
      }

      const { stdout: pending } = await this.git(['rev-list', '--count', `${target}..${source}`]);
      if (pending === '0') {
        if (removeAfter) await this.removeUnlocked(wt, { deleteBranch: true });
        return { status: 'up-to-date', targetBranch: target, commit: null, mode: null, removed: removeAfter };
      }

      const message = input.message ?? `Merge ${strategy === 'squash' ? '(squash) ' : ''}'${source}' into ${target}`;
      const holder = (await this.list()).find((w) => w.branch === target && !w.prunable);

      const commit = holder
        ? await this.mergeInCheckout(holder.path, source, target, strategy, message)
        : await this.mergeByRef(source, target, strategy, message);

      if (removeAfter) await this.removeUnlocked(wt, { deleteBranch: true });
      return { status: 'merged', targetBranch: target, commit, mode: holder ? 'checkout' : 'ref', removed: removeAfter };
    });
  }

  /** Limpia metadatos de worktrees cuya carpeta se borró a mano. Útil al arrancar. */
  async prune(): Promise<void> {
    await this.lock.run(() => this.git(['worktree', 'prune']));
  }

  // ---------------------------------------------------------------------------
  // Internos
  // ---------------------------------------------------------------------------

  private async mergeInCheckout(
    cwd: string,
    source: string,
    target: string,
    strategy: 'merge' | 'squash',
    message: string,
  ): Promise<string> {
    // Ignoramos untracked: no bloquean un merge salvo colisión, y git ya avisa en ese caso.
    if (await this.isDirty(cwd, { ignoreUntracked: true })) throw new DirtyWorktreeError(cwd);

    const args =
      strategy === 'squash' ? ['merge', '--squash', source] : ['merge', '--no-ff', '--no-edit', '-m', message, source];
    const res = await this.git(this.identityArgs(await this.hasIdentity()).concat(args), {
      cwd,
      allowExitCodes: [1],
    });

    if (res.exitCode !== 0) {
      const { stdout } = await this.git(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd });
      const conflicts = splitZ(stdout);
      // `reset --merge` sirve tanto para merge normal como para --squash (que no deja MERGE_HEAD).
      await this.git(['reset', '--merge'], { cwd });
      if (conflicts.length) throw new MergeConflictError(source, target, conflicts);
      throw new GitCommandError(args, res.exitCode, res.stderr || res.stdout);
    }

    if (strategy === 'squash') {
      await this.git([...this.identityArgs(await this.hasIdentity()), 'commit', '-m', message], { cwd });
    }
    return (await this.git(['rev-parse', 'HEAD'], { cwd })).stdout;
  }

  private async mergeByRef(
    source: string,
    target: string,
    strategy: 'merge' | 'squash',
    message: string,
  ): Promise<string> {
    const [targetSha, sourceSha] = await Promise.all([this.revParse(target), this.revParse(source)]);

    // Exit 0 = limpio, 1 = conflictos. Salida -z: <tree>\0<ficheros en conflicto>\0...\0\0<mensajes>
    const res = await this.git(['merge-tree', '--write-tree', '--name-only', '-z', targetSha, sourceSha], {
      allowExitCodes: [1],
    });
    const [tree = '', ...rest] = res.stdout.split('\0');
    if (res.exitCode === 1) {
      const end = rest.indexOf('');
      throw new MergeConflictError(source, target, end === -1 ? rest : rest.slice(0, end));
    }

    const parents = strategy === 'squash' ? ['-p', targetSha] : ['-p', targetSha, '-p', sourceSha];
    const { stdout: commit } = await this.git(
      [...this.identityArgs(await this.hasIdentity()), 'commit-tree', tree, ...parents, '-m', message],
    );
    // Compare-and-swap: si alguien movió `target` mientras tanto, falla en vez de pisarlo.
    await this.git(['update-ref', '-m', `ade: ${message}`, `refs/heads/${target}`, commit, targetSha]);
    return commit;
  }

  private async commitAllUnlocked(wt: WorktreeInfo, message: string): Promise<string | null> {
    await this.git(['add', '-A'], { cwd: wt.path });
    const staged = await this.git(['diff', '--cached', '--quiet'], { cwd: wt.path, allowExitCodes: [1] });
    if (staged.exitCode === 0) return null;
    await this.git([...this.identityArgs(await this.hasIdentity()), 'commit', '--no-verify', '-m', message], {
      cwd: wt.path,
    });
    return this.revParse('HEAD', wt.path);
  }

  private async removeUnlocked(wt: WorktreeInfo, opts: { force?: boolean; deleteBranch?: boolean }): Promise<void> {
    if (wt.isMain) throw new InvalidInputError('No se puede eliminar el worktree principal');

    if (!wt.prunable) {
      if (!opts.force && (await this.isDirty(wt.path))) throw new DirtyWorktreeError(wt.path);
      // Doble --force también elimina worktrees bloqueados.
      const force = opts.force ? ['--force', '--force'] : [];
      await this.git(['worktree', 'remove', ...force, wt.path]);
    }
    await this.git(['worktree', 'prune']);

    if (opts.deleteBranch && wt.branch) {
      // -D: descartar una tarea implica borrar su rama aunque no esté fusionada.
      // git elimina también la sección branch.<b>.* (incluido adeBase).
      await this.git(['branch', '-D', wt.branch], { allowExitCodes: [1] });
    }
  }

  private async status(wt: WorktreeInfo): Promise<WorktreeStatus> {
    const dirty = await this.isDirty(wt.path);
    if (!wt.baseBranch || !(await this.refExists(`refs/heads/${wt.baseBranch}`))) {
      return { dirty, ahead: 0, behind: 0 };
    }
    const { stdout } = await this.git(['rev-list', '--left-right', '--count', `${wt.baseBranch}...HEAD`], {
      cwd: wt.path,
    });
    const [behind = 0, ahead = 0] = stdout.split(/\s+/).map(Number);
    return { dirty, ahead, behind };
  }

  private async isDirty(cwd: string, opts: { ignoreUntracked?: boolean } = {}): Promise<boolean> {
    const args = ['status', '--porcelain', '-z'];
    if (opts.ignoreUntracked) args.push('--untracked-files=no');
    return (await this.git(args, { cwd })).stdout.length > 0;
  }

  private async defaultBranch(): Promise<string> {
    if (this.defaultBranchOverride) return this.defaultBranchOverride;
    for (const candidate of ['main', 'master']) {
      if (await this.refExists(`refs/heads/${candidate}`)) return candidate;
    }
    const head = await this.git(['symbolic-ref', '--short', '-q', 'HEAD'], { allowExitCodes: [1] });
    if (head.stdout) return head.stdout;
    throw new InvalidInputError('No se pudo determinar la rama principal; indica baseRef explícitamente');
  }

  private requireBase(wt: WorktreeInfo): string {
    if (!wt.baseBranch) {
      throw new InvalidInputError(`El worktree '${wt.id}' no tiene rama base registrada; indica targetBranch`);
    }
    return wt.baseBranch;
  }

  private async readBaseBranches(): Promise<Map<string, string>> {
    // Exit 1 = ninguna clave coincide.
    const { stdout } = await this.git(
      // git normaliza el nombre de la variable a minúsculas (el de la rama no).
      ['config', '--local', '-z', '--get-regexp', `^branch\\..*\\.${BASE_CONFIG_KEY.toLowerCase()}$`],
      { allowExitCodes: [1] },
    );
    const map = new Map<string, string>();
    for (const entry of splitZ(stdout)) {
      // Formato -z: "<clave>\n<valor>". La clave conserva mayúsculas en el nombre de rama.
      const nl = entry.indexOf('\n');
      const key = entry.slice(0, nl);
      const branch = key.slice('branch.'.length, key.length - BASE_CONFIG_KEY.length - 1);
      map.set(branch, entry.slice(nl + 1));
    }
    return map;
  }

  private async assertBranchName(branch: string): Promise<void> {
    const res = await this.git(['check-ref-format', '--branch', branch], { allowExitCodes: [1, 128] });
    if (res.exitCode !== 0) throw new InvalidInputError(`Nombre de rama inválido: '${branch}'`);
  }

  private async refExists(ref: string): Promise<boolean> {
    const res = await this.git(['rev-parse', '--verify', '--quiet', ref], { allowExitCodes: [1, 128] });
    return res.exitCode === 0;
  }

  private async revParse(ref: string, cwd?: string): Promise<string> {
    return (await this.git(['rev-parse', '--verify', `${ref}^{commit}`], { cwd })).stdout;
  }

  private async hasIdentity(): Promise<boolean> {
    const res = await this.git(['config', 'user.email'], { allowExitCodes: [1] });
    return res.exitCode === 0 && res.stdout.length > 0;
  }

  private identityArgs(hasIdentity: boolean): string[] {
    if (hasIdentity) return [];
    return ['-c', `user.name=${this.committer.name}`, '-c', `user.email=${this.committer.email}`];
  }

  private async git(args: string[], opts: GitRunOptions = {}) {
    const res = await execa('git', args, {
      cwd: opts.cwd ?? this.repoRoot,
      env: { ...GIT_ENV, ...opts.env },
      reject: false,
      maxBuffer: 64 * 1024 * 1024,
    });
    const ok = res.exitCode === 0 || (res.exitCode !== undefined && opts.allowExitCodes?.includes(res.exitCode));
    if (!ok) throw new GitCommandError(args, res.exitCode, res.stderr || (res.message ?? ''));
    return res;
  }
}

// -----------------------------------------------------------------------------
// Helpers puros (exportados para tests)
// -----------------------------------------------------------------------------

interface PorcelainRecord {
  path: string;
  head: string;
  branch: string | null;
  locked: boolean;
  prunable: boolean;
}

export function parseWorktreePorcelain(out: string): PorcelainRecord[] {
  const records: PorcelainRecord[] = [];
  let cur: PorcelainRecord | null = null;
  for (const line of out.split('\0')) {
    if (line === '') {
      if (cur) records.push(cur);
      cur = null;
      continue;
    }
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? '' : line.slice(sp + 1);
    if (key === 'worktree') cur = { path: value, head: '', branch: null, locked: false, prunable: false };
    else if (!cur) continue;
    else if (key === 'HEAD') cur.head = value;
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'locked') cur.locked = true;
    else if (key === 'prunable') cur.prunable = true;
  }
  if (cur) records.push(cur);
  return records;
}

export function parseFileChanges(nameStatusZ: string, numstatZ: string): FileChange[] {
  const stats = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const entry of splitZ(numstatZ)) {
    const [add = '-', del = '-', ...p] = entry.split('\t');
    stats.set(p.join('\t'), { additions: add === '-' ? null : Number(add), deletions: del === '-' ? null : Number(del) });
  }
  const parts = splitZ(nameStatusZ);
  const files: FileChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!.charAt(0) as FileChangeStatus;
    const file = parts[i + 1]!;
    files.push({ path: file, status, ...(stats.get(file) ?? { additions: null, deletions: null }) });
  }
  return files;
}

export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

function splitZ(s: string): string[] {
  return s.split('\0').filter(Boolean);
}

function isInside(dir: string, p: string): boolean {
  const rel = path.relative(dir, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function assertValidId(id: string): void {
  // También evita path traversal: el id acaba en una ruta del sistema de ficheros.
  if (!ID_RE.test(id)) throw new InvalidInputError(`Id de worktree inválido: '${id}'`);
}

async function assertGitVersion(): Promise<void> {
  const res = await execa('git', ['--version'], { reject: false });
  const m = /(\d+)\.(\d+)/.exec(res.stdout ?? '');
  if (res.exitCode !== 0 || !m) throw new AdeError('git no está instalado o no está en el PATH', 'GIT_MISSING');
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major < MIN_GIT_VERSION[0] || (major === MIN_GIT_VERSION[0] && minor < MIN_GIT_VERSION[1])) {
    throw new AdeError(`Se requiere git >= ${MIN_GIT_VERSION.join('.')} (encontrado ${m[0]})`, 'GIT_TOO_OLD');
  }
}
