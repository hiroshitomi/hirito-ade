// Errores de dominio. `statusCode` permite que el error handler de Fastify los
// traduzca a HTTP sin conocer cada tipo.

export class AdeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 500,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class GitCommandError extends AdeError {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | undefined,
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} falló (exit ${exitCode ?? '?'}): ${stderr.trim()}`, 'GIT_COMMAND_FAILED', 500);
  }
}

export class InvalidInputError extends AdeError {
  constructor(message: string) {
    super(message, 'INVALID_INPUT', 400);
  }
}

export class WorktreeNotFoundError extends AdeError {
  constructor(id: string) {
    super(`Worktree '${id}' no encontrado`, 'WORKTREE_NOT_FOUND', 404);
  }
}

export class BranchExistsError extends AdeError {
  constructor(branch: string) {
    super(`La rama '${branch}' ya existe`, 'BRANCH_EXISTS', 409);
  }
}

export class DirtyWorktreeError extends AdeError {
  constructor(path: string) {
    super(`El worktree '${path}' tiene cambios sin commitear`, 'WORKTREE_DIRTY', 409);
  }
}

export class MergeConflictError extends AdeError {
  constructor(source: string, target: string, readonly conflicts: string[]) {
    super(`Conflictos al fusionar '${source}' en '${target}'`, 'MERGE_CONFLICT', 409, { conflicts });
  }
}
