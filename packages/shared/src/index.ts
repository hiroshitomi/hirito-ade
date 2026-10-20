// Contratos compartidos entre server y web. Solo tipos: se borran al compilar.

export interface WorktreeInfo {
  /** Identificador estable y URL-safe (= nombre de la carpeta del worktree). */
  id: string;
  /** Repo al que pertenece (nombre de su carpeta); en un workspace hay varios. */
  repo: string;
  path: string;
  /** Nombre legible con el que se creó la tarea. */
  title: string | null;
  /** null si el worktree está en detached HEAD. */
  branch: string | null;
  head: string;
  /** Rama desde la que se creó (persistida en git config como branch.<b>.adeBase). */
  baseBranch: string | null;
  isMain: boolean;
  /** true si vive dentro del directorio de worktrees gestionado por ADE. */
  managed: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface WorktreeStatus {
  dirty: boolean;
  /** Commits en la rama del worktree que no están en la base. */
  ahead: number;
  /** Commits en la base que no están en la rama del worktree. */
  behind: number;
  /**
   * Trabajo del agente respecto al punto de partida (merge-base con la base):
   * commits + cambios sin commitear + ficheros nuevos.
   */
  changes: ChangeStats;
}

export interface ChangeStats {
  files: number;
  additions: number;
  deletions: number;
  /** Rutas tocadas (máx. 500), para detectar solapes entre tareas. */
  paths: string[];
}

/** Otra tarea activa que está tocando los mismos ficheros: riesgo de conflicto al fusionar. */
export interface WorktreeOverlap {
  worktreeId: string;
  title: string | null;
  files: string[];
}

export type WorktreeWithStatus = WorktreeInfo & { status: WorktreeStatus | null };

/** Respuesta de GET /api/worktrees y GET /api/worktrees/:id. */
export type WorktreeSummary = WorktreeWithStatus & {
  agentRunning: boolean;
  /** Última ejecución de agente en este worktree, si la hubo. */
  agent: AgentRunInfo | null;
  /** Tareas que tocan alguno de los mismos ficheros. */
  overlaps: WorktreeOverlap[];
};

export interface CreateWorktreeInput {
  /** Repo del proyecto en el que crear la tarea (obligatorio si el proyecto tiene varios). */
  repo?: string;
  /** Nombre legible de la tarea; se usa para generar id y rama. */
  name: string;
  /** Rama/commit de partida. Por defecto la rama principal detectada. */
  baseRef?: string;
  /** Nombre de rama explícito. Por defecto `ade/<id>`. */
  branch?: string;
}

export type FileChangeStatus = 'A' | 'M' | 'D' | 'T' | 'U' | 'X';

export interface FileChange {
  path: string;
  status: FileChangeStatus;
  /** null para ficheros binarios. */
  additions: number | null;
  deletions: number | null;
}

export interface WorktreeDiff {
  baseBranch: string;
  mergeBase: string;
  files: FileChange[];
  /** Unified diff (commits + cambios sin commitear + ficheros nuevos). */
  patch: string;
}

export type MergeStrategy = 'merge' | 'squash';

export interface MergeWorktreeInput {
  /** Rama destino. Por defecto la baseBranch del worktree. */
  targetBranch?: string;
  strategy?: MergeStrategy;
  message?: string;
  /** Commitea automáticamente los cambios pendientes del agente. Default: true. */
  commitPending?: boolean;
  /** Elimina worktree + rama tras fusionar. Default: true. */
  removeAfter?: boolean;
}

export interface MergeWorktreeRequest extends MergeWorktreeInput {
  id: string;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}

export interface MergeResult {
  status: 'merged' | 'up-to-date';
  targetBranch: string;
  commit: string | null;
  /** 'checkout': merge en el worktree que tiene la rama destino; 'ref': merge-tree sin tocar ningún checkout. */
  mode: 'checkout' | 'ref' | null;
  removed: boolean;
}

// -----------------------------------------------------------------------------
// Agentes (Fase 2)
// -----------------------------------------------------------------------------

export interface AgentPresetInfo {
  id: string;
  label: string;
  /** Si el preset acepta un prompt inicial. */
  acceptsPrompt: boolean;
  /** Modos de permisos que admite (vacío si el agente no los soporta). */
  modes: AgentMode[];
}

/**
 * Cómo pide permisos el agente (Claude Code `--permission-mode`):
 * - manual: pregunta antes de cada edición o comando.
 * - auto: decide solo lo seguro y pregunta lo arriesgado (clasificador de Claude Code).
 * - plan: solo investiga y propone un plan; no toca ficheros hasta que lo apruebes.
 */
export type AgentMode = 'manual' | 'auto' | 'plan';

export interface StartAgentInput {
  worktreeId: string;
  preset: string;
  prompt?: string;
  mode?: AgentMode;
  cols?: number;
  rows?: number;
}

export type AgentRunStatus = 'running' | 'exited' | 'stopped';

/**
 * Solo con status 'running': 'working' mientras el agente produce salida,
 * 'waiting' tras unos segundos de silencio (pide confirmación o terminó su turno).
 */
export type AgentActivity = 'working' | 'waiting';

export interface AgentRunInfo {
  id: string;
  worktreeId: string;
  preset: string;
  /** Modo con el que arrancó (el agente puede cambiarlo después, p.ej. Shift+Tab en Claude Code). */
  mode: AgentMode | null;
  command: string;
  args: string[];
  pid: number;
  status: AgentRunStatus;
  activity: AgentActivity | null;
  exitCode: number | null;
  signal: number | null;
  startedAt: string;
  endedAt: string | null;
}

/**
 * Eventos SSE de GET /api/agents/:id/stream. El `id:` SSE es el `seq` del chunk,
 * así EventSource reanuda con Last-Event-ID tras una reconexión sin duplicar salida.
 */
export type AgentStreamEvent =
  | { type: 'output'; seq: number; data: string }
  | { type: 'exit'; run: AgentRunInfo };

/** Eventos SSE de GET /api/events: cambios de estado de cualquier agente. */
export type AdeEvent =
  | { type: 'agent'; run: AgentRunInfo }
  | { type: 'usage'; usage: ClaudeUsage }
  /** Se abrió otro proyecto: el dashboard debe recargar todo. */
  | { type: 'project'; project: ProjectInfo | null };

// -----------------------------------------------------------------------------
// Cuenta de Claude (suscripción)
// -----------------------------------------------------------------------------

export interface ClaudeAuthStatus {
  /** El comando `claude` existe en el PATH del servidor. */
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  /** Tal como lo reporta `claude auth status` (p.ej. 'claude.ai', 'oauth_token', 'api_key'). */
  authMethod: string | null;
  /** true si los agentes consumirán tu suscripción y no facturación por API. */
  usesSubscription: boolean;
  email: string | null;
  subscriptionType: string | null;
  orgName: string | null;
  /** Variables de API definidas en el entorno del servidor que ADE quita a los agentes. */
  ignoredEnvVars: string[];
  error: string | null;
}

// -----------------------------------------------------------------------------
// Proyecto, GitHub y uso
// -----------------------------------------------------------------------------

/** Estado de un repo del proyecto (su checkout principal). */
export interface RepoInfo {
  name: string;
  path: string;
  /** Rama del checkout principal (null en detached HEAD). */
  branch: string | null;
  /** Ficheros con cambios sin commitear en el checkout principal. */
  changes: number;
  /** Remoto `origin`, sin credenciales embebidas en la URL. */
  remote: { url: string; github: { owner: string; repo: string; url: string } | null } | null;
  /** Comparación con la rama remota que sigue la actual (sin hacer fetch). */
  upstream: { name: string; ahead: number; behind: number } | null;
}

/**
 * Proyecto abierto en ADE:
 * - 'repo': la carpeta es un repositorio git.
 * - 'workspace': la carpeta contiene varios repositorios (front, back, microservicios…).
 */
export interface ProjectInfo {
  name: string;
  path: string;
  kind: 'repo' | 'workspace';
  /** `.claude/skills` en la raíz del proyecto, si existe. */
  skillsPath: string | null;
  repos: RepoInfo[];
}

export interface RecentProject {
  name: string;
  path: string;
  kind: 'repo' | 'workspace';
  openedAt: string;
}

/** Respuesta de GET /api/project. */
export interface ProjectState {
  project: ProjectInfo | null;
  recent: RecentProject[];
}

/** Respuesta de GET /api/project/browse: carpetas para el navegador integrado. */
export interface FolderListing {
  path: string;
  /** null en la raíz (o en la lista de unidades en Windows). */
  parent: string | null;
  /** La carpeta actual es un repo git. */
  isRepo: boolean;
  /** Cuántas subcarpetas son repos git (si > 0, es un workspace válido). */
  repoCount: number;
  entries: { name: string; path: string; isRepo: boolean }[];
  /** Accesos rápidos: carpeta personal y, en Windows, las unidades (C:\, D:\…). */
  roots: { name: string; path: string }[];
}

export interface GitHubAuthStatus {
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  login: string | null;
  host: string;
  /** De dónde sale el token: 'keyring', 'oauth_token', 'GH_TOKEN'… */
  tokenSource: string | null;
  gitProtocol: string | null;
  error: string | null;
}

export interface UsageWindow {
  /** 0–100 */
  usedPercentage: number;
  /** ISO 8601 */
  resetsAt: string;
}

/** Límites de la suscripción de Claude (Pro/Max), tal como los reporta Claude Code. */
export interface ClaudeUsage {
  /** Ventana móvil de 5 horas. */
  fiveHour: UsageWindow | null;
  /** Límite semanal. */
  sevenDay: UsageWindow | null;
  /** Cuándo llegó el último dato (de cualquier agente). null = nunca. */
  updatedAt: string | null;
}
