import { ArrowDown, ArrowUp, FileDiff, TriangleAlert } from 'lucide-react';
import type { WorktreeSummary } from '@ade/shared';

/**
 * Estado del código de una tarea en una línea: lo que ha cambiado el agente
 * respecto a su punto de partida, si su base avanzó (otra tarea se fusionó) y si
 * comparte ficheros con otras tareas en curso.
 */
export function CodeState({ wt, className = '' }: { wt: WorktreeSummary; className?: string }) {
  const s = wt.status;
  if (!s) return null;
  const c = s.changes;
  return (
    <span className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs ${className}`}>
      <span className="flex items-center gap-1 text-zinc-400" title={c.paths.slice(0, 20).join('\n') || 'Sin cambios'}>
        <FileDiff className="size-3" />
        {c.files ? (
          <>
            {c.files} fichero{c.files === 1 ? '' : 's'}
            <span className="text-emerald-400">+{c.additions}</span>
            <span className="text-rose-400">−{c.deletions}</span>
          </>
        ) : (
          'sin cambios'
        )}
      </span>
      {s.ahead ? (
        <span className="flex items-center text-zinc-400" title="Commits del agente aún no fusionados en la base">
          <ArrowUp className="size-3" />
          {s.ahead} commit{s.ahead === 1 ? '' : 's'}
        </span>
      ) : null}
      {s.behind ? (
        <span
          className="flex items-center text-amber-300"
          title={`${wt.baseBranch} avanzó desde que empezó esta tarea (p.ej. se fusionó otra). Al fusionar se combinarán ambos cambios.`}
        >
          <ArrowDown className="size-3" />
          base +{s.behind}
        </span>
      ) : null}
      <OverlapWarning wt={wt} />
    </span>
  );
}

export function OverlapWarning({ wt, verbose = false }: { wt: WorktreeSummary; verbose?: boolean }) {
  if (!wt.overlaps.length) return null;
  const detail = wt.overlaps
    .map((o) => `«${o.title ?? o.worktreeId}»: ${o.files.slice(0, 5).join(', ')}${o.files.length > 5 ? '…' : ''}`)
    .join('\n');
  const files = new Set(wt.overlaps.flatMap((o) => o.files)).size;
  return (
    <span
      className="flex items-center gap-1 font-medium text-amber-300"
      title={`Riesgo de conflicto al fusionar. Ficheros también tocados por:\n${detail}`}
    >
      <TriangleAlert className="size-3" />
      {verbose
        ? `Comparte ${files} fichero${files === 1 ? '' : 's'} con ${wt.overlaps.map((o) => `«${o.title ?? o.worktreeId}»`).join(', ')}`
        : `${files} en común con ${wt.overlaps.length} tarea${wt.overlaps.length === 1 ? '' : 's'}`}
    </span>
  );
}
