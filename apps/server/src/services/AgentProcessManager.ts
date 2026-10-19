import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import type { AgentActivity, AgentPresetInfo, AgentRunInfo, AgentStreamEvent } from '@ade/shared';
import { childEnv, type AgentPreset } from '../config.js';
import { AdeError, InvalidInputError } from '../lib/errors.js';

export interface AgentProcessManagerOptions {
  presets: Record<string, AgentPreset>;
  /** Bytes de salida retenidos por agente para reproducir a clientes que se conectan tarde. */
  maxBufferBytes?: number;
  /** Ventana para agrupar chunks del PTY en un único evento (TUIs emiten miles de chunks pequeños). */
  flushIntervalMs?: number;
  /** Tiempo entre SIGTERM y SIGKILL al detener. */
  killTimeoutMs?: number;
  /**
   * Silencio tras el cual se considera que el agente espera input. Las TUIs como
   * Claude Code redibujan un spinner sin parar mientras trabajan, así que un PTY
   * callado casi siempre significa "esperando tu respuesta".
   */
  idleMs?: number;
  /** Variables añadidas al entorno de todos los agentes (p.ej. a dónde reportar el uso). */
  env?: Record<string, string>;
}

export interface StartAgentOptions {
  worktreeId: string;
  cwd: string;
  preset: string;
  prompt?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

export class AgentNotFoundError extends AdeError {
  constructor(id: string) {
    super(`Agente '${id}' no encontrado`, 'AGENT_NOT_FOUND', 404);
  }
}

export class AgentBusyError extends AdeError {
  constructor(worktreeId: string, runId: string) {
    super(`El worktree '${worktreeId}' ya tiene un agente en ejecución`, 'AGENT_BUSY', 409, { runId });
  }
}

export class AgentNotRunningError extends AdeError {
  constructor(id: string) {
    super(`El agente '${id}' no está en ejecución`, 'AGENT_NOT_RUNNING', 409);
  }
}

const EXIT_DRAIN_MS = 50;

interface Chunk {
  seq: number;
  data: string;
}

class AgentRun extends EventEmitter<{ event: [AgentStreamEvent]; change: [AgentRunInfo] }> {
  info: AgentRunInfo;
  private chunks: Chunk[] = [];
  private bufferedBytes = 0;
  private seq = 0;
  private pending = '';
  private flushTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private stopRequested = false;
  private lastOutputAt = Date.now();
  private readonly idleCheck: NodeJS.Timeout;
  readonly exited: Promise<void>;

  constructor(
    info: Pick<AgentRunInfo, 'id' | 'worktreeId' | 'preset' | 'command' | 'args'>,
    readonly proc: pty.IPty,
    private readonly maxBufferBytes: number,
    private readonly flushIntervalMs: number,
    idleMs: number,
  ) {
    super();
    // Un SSE por cliente: evita el warning de "possible memory leak" con muchos espectadores.
    this.setMaxListeners(0);
    this.info = {
      ...info,
      pid: proc.pid,
      status: 'running',
      exitCode: null,
      signal: null,
      activity: 'working',
      startedAt: new Date().toISOString(),
      endedAt: null,
    };

    // Un único intervalo por agente: más barato que reprogramar un timer en cada chunk.
    this.idleCheck = setInterval(() => {
      if (this.info.activity === 'working' && Date.now() - this.lastOutputAt >= idleMs) {
        this.setActivity('waiting');
      }
    }, Math.max(50, Math.min(500, idleMs / 4)));

    let finalize: (() => void) | null = null;
    proc.onData((data) => {
      this.pending += data;
      this.flushTimer ??= setTimeout(() => this.flush(), this.flushIntervalMs);
      finalize?.(); // aún llega salida tras onExit: reinicia la espera de drenaje
    });

    this.exited = new Promise((resolve) => {
      proc.onExit(({ exitCode, signal }) => {
        // Margen por si llega algún onData tras onExit (node-pty ya espera al cierre
        // del socket en Unix; esto cubre otras plataformas). Limitación conocida de
        // node-pty/kernel: bajo carga, a veces se pierde la última salida de un proceso
        // que termina justo después de escribirla; no es recuperable desde aquí.
        let drainTimer: NodeJS.Timeout | undefined;
        finalize = () => {
          clearTimeout(drainTimer);
          drainTimer = setTimeout(() => this.finish(exitCode, signal, resolve), EXIT_DRAIN_MS);
        };
        finalize();
      });
    });
  }

  private finish(exitCode: number, signal: number | undefined, resolve: () => void): void {
    this.flush();
    if (this.killTimer) clearTimeout(this.killTimer);
    clearInterval(this.idleCheck);
    this.info = {
      ...this.info,
      activity: null,
      status: this.stopRequested ? 'stopped' : 'exited',
      exitCode,
      signal: signal ?? null,
      endedAt: new Date().toISOString(),
    };
    this.emit('event', { type: 'exit', run: this.info });
    this.emit('change', this.info);
    resolve();
  }

  private setActivity(activity: AgentActivity): void {
    if (this.info.activity === activity) return;
    this.info = { ...this.info, activity };
    this.emit('change', this.info);
  }

  get running(): boolean {
    return this.info.status === 'running';
  }

  /** Chunks con seq > afterSeq, para reanudar un stream sin duplicar. */
  replay(afterSeq = 0): Chunk[] {
    return this.chunks.filter((c) => c.seq > afterSeq);
  }

  stop(killTimeoutMs: number): Promise<void> {
    if (this.running && !this.stopRequested) {
      this.stopRequested = true;
      this.proc.kill('SIGTERM');
      this.killTimer = setTimeout(() => this.proc.kill('SIGKILL'), killTimeoutMs);
    }
    return this.exited;
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.pending) return;

    const chunk = { seq: ++this.seq, data: this.pending };
    this.pending = '';
    this.lastOutputAt = Date.now();
    if (this.info.activity === 'waiting') this.setActivity('working');
    this.chunks.push(chunk);
    this.bufferedBytes += chunk.data.length;
    // Ring buffer: descartamos lo más antiguo, conservando siempre el último chunk.
    while (this.bufferedBytes > this.maxBufferBytes && this.chunks.length > 1) {
      this.bufferedBytes -= this.chunks.shift()!.data.length;
    }
    this.emit('event', { type: 'output', ...chunk });
  }
}

/**
 * Lanza agentes CLI dentro de un PTY (pseudo-terminal). A diferencia de
 * child_process.spawn, el agente ve un TTY real: colores, TUIs interactivas
 * (Claude Code, Codex) y redimensionado funcionan igual que en tu terminal.
 */
export class AgentProcessManager {
  private readonly runs = new Map<string, AgentRun>();
  private readonly presets: Record<string, AgentPreset>;
  private readonly maxBufferBytes: number;
  private readonly flushIntervalMs: number;
  private readonly killTimeoutMs: number;
  private readonly idleMs: number;
  private readonly baseEnv: Record<string, string>;
  /** Cambios de estado de cualquier agente (arranque, working/waiting, fin) para GET /api/events. */
  private readonly changes = new EventEmitter<{ change: [AgentRunInfo] }>().setMaxListeners(0);

  constructor(opts: AgentProcessManagerOptions) {
    this.presets = opts.presets;
    this.maxBufferBytes = opts.maxBufferBytes ?? 2 * 1024 * 1024;
    this.flushIntervalMs = opts.flushIntervalMs ?? 16;
    this.killTimeoutMs = opts.killTimeoutMs ?? 5000;
    this.idleMs = opts.idleMs ?? 2500;
    this.baseEnv = opts.env ?? {};
  }

  onChange(listener: (run: AgentRunInfo) => void): () => void {
    this.changes.on('change', listener);
    return () => this.changes.off('change', listener);
  }

  listPresets(): AgentPresetInfo[] {
    return Object.entries(this.presets)
      .filter(([, p]) => !p.hidden)
      .map(([id, p]) => ({ id, label: p.label, acceptsPrompt: p.acceptsPrompt }));
  }

  /** Presets que la API pública puede lanzar (excluye los internos, como el login). */
  isPublicPreset(id: string): boolean {
    const preset = this.presets[id];
    return preset !== undefined && !preset.hidden;
  }

  start(opts: StartAgentOptions): AgentRunInfo {
    const preset = this.presets[opts.preset];
    if (!preset) throw new InvalidInputError(`Preset desconocido: '${opts.preset}'`);
    const busy = this.runningFor(opts.worktreeId);
    if (busy) throw new AgentBusyError(opts.worktreeId, busy.info.id);

    const id = randomUUID();
    const args = preset.args(opts.prompt);
    let proc: pty.IPty;
    try {
      proc = pty.spawn(preset.command, args, {
        name: 'xterm-256color',
        cwd: opts.cwd,
        cols: opts.cols ?? 120,
        rows: opts.rows ?? 32,
        env: childEnv(preset.unsetEnv, {
          ...this.baseEnv,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          ADE_WORKTREE_ID: opts.worktreeId,
          ADE_AGENT_ID: id,
          ...opts.env,
        }),
      });
    } catch (err) {
      throw new AdeError(`No se pudo lanzar '${preset.command}': ${(err as Error).message}`, 'AGENT_SPAWN_FAILED', 500);
    }

    const run = new AgentRun(
      { id, worktreeId: opts.worktreeId, preset: opts.preset, command: preset.command, args },
      proc,
      this.maxBufferBytes,
      this.flushIntervalMs,
      this.idleMs,
    );
    this.runs.set(id, run);
    run.on('change', (info) => this.changes.emit('change', info));
    this.changes.emit('change', run.info);
    return run.info;
  }

  /** Como start(), pero si ya hay un proceso en marcha para ese id lo devuelve (p.ej. un login en curso). */
  startOrReuse(opts: StartAgentOptions): AgentRunInfo {
    return this.runningFor(opts.worktreeId)?.info ?? this.start(opts);
  }

  list(filter: { worktreeId?: string } = {}): AgentRunInfo[] {
    return [...this.runs.values()]
      .filter((r) => !filter.worktreeId || r.info.worktreeId === filter.worktreeId)
      .map((r) => r.info);
  }

  get(id: string): AgentRunInfo {
    return this.require(id).info;
  }

  /** Última ejecución (activa o no) de un worktree. */
  latestFor(worktreeId: string): AgentRunInfo | null {
    const runs = this.list({ worktreeId });
    return runs.at(-1) ?? null;
  }

  /** Envía input (teclas desde xterm.js) al stdin del agente. */
  write(id: string, data: string): void {
    const run = this.requireRunning(id);
    run.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.requireRunning(id).proc.resize(cols, rows);
  }

  async stop(id: string): Promise<AgentRunInfo> {
    const run = this.require(id);
    await run.stop(this.killTimeoutMs);
    return run.info;
  }

  isRunningFor(worktreeId: string): boolean {
    return this.runningFor(worktreeId) !== undefined;
  }

  /** Detiene los agentes del worktree y olvida su historial (al eliminar/fusionar). */
  async disposeWorktree(worktreeId: string): Promise<void> {
    const runs = [...this.runs.values()].filter((r) => r.info.worktreeId === worktreeId);
    await Promise.all(runs.map((r) => r.stop(this.killTimeoutMs)));
    for (const r of runs) this.runs.delete(r.info.id);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runs.values()].map((r) => r.stop(this.killTimeoutMs)));
  }

  /**
   * Suscribe a la salida del agente. Primero reproduce el buffer (desde afterSeq)
   * y después emite en vivo. Devuelve la función para cancelar la suscripción.
   */
  subscribe(id: string, afterSeq: number, onEvent: (e: AgentStreamEvent) => void): () => void {
    const run = this.require(id);
    // Replay y suscripción en el mismo tick: no se puede colar un chunk entre ambos.
    for (const c of run.replay(afterSeq)) onEvent({ type: 'output', ...c });
    if (!run.running) {
      onEvent({ type: 'exit', run: run.info });
      return () => {};
    }
    run.on('event', onEvent);
    return () => run.off('event', onEvent);
  }

  private runningFor(worktreeId: string): AgentRun | undefined {
    return [...this.runs.values()].find((r) => r.info.worktreeId === worktreeId && r.running);
  }

  private require(id: string): AgentRun {
    const run = this.runs.get(id);
    if (!run) throw new AgentNotFoundError(id);
    return run;
  }

  private requireRunning(id: string): AgentRun {
    const run = this.require(id);
    if (!run.running) throw new AgentNotRunningError(id);
    return run;
  }
}
