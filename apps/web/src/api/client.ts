import type {
  AgentPresetInfo,
  AgentRunInfo,
  ApiErrorBody,
  ClaudeAuthStatus,
  ClaudeUsage,
  CreateWorktreeInput,
  GitHubAuthStatus,
  MergeResult,
  MergeWorktreeRequest,
  ProjectInfo,
  StartAgentInput,
  WorktreeDiff,
  WorktreeInfo,
  WorktreeSummary,
} from '@ade/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  /** Ficheros en conflicto si el error viene de un merge. */
  get conflicts(): string[] {
    const d = this.details as { conflicts?: string[] } | undefined;
    return d?.conflicts ?? [];
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data ?? {}) as Partial<ApiErrorBody>;
    throw new ApiError(res.status, err.error ?? 'HTTP_ERROR', err.message ?? res.statusText, err.details);
  }
  return data as T;
}

export const api = {
  listWorktrees: () => request<WorktreeSummary[]>('GET', '/api/worktrees'),
  createWorktree: (input: CreateWorktreeInput) => request<WorktreeInfo>('POST', '/api/worktrees/create', input),
  getDiff: (id: string) => request<WorktreeDiff>('GET', `/api/worktrees/${id}/diff`),
  mergeWorktree: (input: MergeWorktreeRequest) => request<MergeResult>('POST', '/api/worktrees/merge', input),
  removeWorktree: (id: string, opts: { force?: boolean } = {}) =>
    request<void>('DELETE', `/api/worktrees/${id}${opts.force ? '?force=true' : ''}`),

  listPresets: () => request<AgentPresetInfo[]>('GET', '/api/agents/presets'),
  listAgents: (worktreeId: string) =>
    request<AgentRunInfo[]>('GET', `/api/agents?worktreeId=${encodeURIComponent(worktreeId)}`),
  startAgent: (input: StartAgentInput) => request<AgentRunInfo>('POST', '/api/agents', input),
  stopAgent: (id: string) => request<AgentRunInfo>('POST', `/api/agents/${id}/stop`),
  sendInput: (id: string, data: string) => request<void>('POST', `/api/agents/${id}/input`, { data }),
  resize: (id: string, cols: number, rows: number) =>
    request<void>('POST', `/api/agents/${id}/resize`, { cols, rows }),
  streamUrl: (id: string) => `/api/agents/${id}/stream`,

  claudeStatus: () => request<ClaudeAuthStatus>('GET', '/api/claude/status'),
  claudeLogin: () => request<AgentRunInfo>('POST', '/api/claude/login'),
  claudeLogout: () => request<ClaudeAuthStatus>('POST', '/api/claude/logout'),
  usage: () => request<ClaudeUsage>('GET', '/api/usage'),

  githubStatus: () => request<GitHubAuthStatus>('GET', '/api/github/status'),
  githubLogin: () => request<AgentRunInfo>('POST', '/api/github/login'),
  githubLogout: () => request<GitHubAuthStatus>('POST', '/api/github/logout'),

  project: () => request<ProjectInfo>('GET', '/api/project'),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError && err.conflicts.length) {
    return `${err.message}: ${err.conflicts.join(', ')}`;
  }
  return err instanceof Error ? err.message : String(err);
}
