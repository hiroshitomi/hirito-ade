// Contratos compartidos entre server y web. Solo tipos: se borran al compilar.

export interface WorktreeInfo {
  /** Identificador estable y URL-safe (= nombre de la carpeta del worktree). */
  id: string;
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
}

export type WorktreeWithStatus = WorktreeInfo & { status: WorktreeStatus | null };

/** Respuesta de GET /api/worktrees y GET /api/worktrees/:id. */
export type WorktreeSummary = WorktreeWithStatus & {
  agentRunning: boolean;
  /** Última ejecución de agente en este worktree, si la hubo. */
  agent: AgentRunInfo | null;
};

export interface CreateWorktreeInput {
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
}

export interface StartAgentInput {
  worktreeId: string;
  preset: string;
  prompt?: string;
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
export type AdeEvent = { type: 'agent'; run: AgentRunInfo };

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
