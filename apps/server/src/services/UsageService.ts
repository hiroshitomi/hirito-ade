import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ClaudeUsage, UsageWindow } from '@ade/shared';

/** Formato que reporta la status line (el de Claude Code: % y epoch en segundos). */
export interface RawWindow {
  used_percentage: number;
  resets_at: number;
}

const EMPTY: ClaudeUsage = { fiveHour: null, sevenDay: null, updatedAt: null };

/**
 * Último uso conocido de la suscripción de Claude. Se persiste en disco para
 * seguir mostrándolo tras reiniciar ADE o cuando no hay agentes en marcha.
 */
export class UsageService {
  private usage: ClaudeUsage = EMPTY;
  private readonly changes = new EventEmitter<{ change: [ClaudeUsage] }>().setMaxListeners(0);

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      this.usage = { ...EMPTY, ...(JSON.parse(await readFile(this.file, 'utf8')) as ClaudeUsage) };
    } catch {
      // Primer arranque o fichero corrupto: sin datos.
    }
  }

  /** Uso actual; una ventana cuyo reinicio ya pasó se considera vacía (como hace Claude Code). */
  get(now = Date.now()): ClaudeUsage {
    const live = (w: UsageWindow | null) => (w && Date.parse(w.resetsAt) > now ? w : null);
    return { ...this.usage, fiveHour: live(this.usage.fiveHour), sevenDay: live(this.usage.sevenDay) };
  }

  async report(input: { fiveHour: RawWindow | null; sevenDay: RawWindow | null }): Promise<ClaudeUsage> {
    const toWindow = (w: RawWindow | null): UsageWindow | null =>
      w ? { usedPercentage: Math.min(100, Math.max(0, w.used_percentage)), resetsAt: new Date(w.resets_at * 1000).toISOString() } : null;
    // Una ventana ausente en este reporte conserva el último valor conocido.
    this.usage = {
      fiveHour: toWindow(input.fiveHour) ?? this.usage.fiveHour,
      sevenDay: toWindow(input.sevenDay) ?? this.usage.sevenDay,
      updatedAt: new Date().toISOString(),
    };
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.usage, null, 2));
    const current = this.get();
    this.changes.emit('change', current);
    return current;
  }

  onChange(listener: (usage: ClaudeUsage) => void): () => void {
    this.changes.on('change', listener);
    return () => this.changes.off('change', listener);
  }
}
