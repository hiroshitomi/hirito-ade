import { ArrowDown, ArrowUp, Bot, CircleDot, GitBranch, Hand } from 'lucide-react';
import type { WorktreeSummary } from '@ade/shared';
import { agentState, taskTitle } from '../lib/agentState';

type Column = 'waiting' | 'running' | 'review' | 'idle';

const COLUMNS: { id: Column; title: string; empty: string; accent: string }[] = [
  { id: 'waiting', title: 'Te necesita', empty: 'Ningún agente esperando', accent: 'bg-amber-400' },
  { id: 'running', title: 'En curso', empty: 'Ningún agente trabajando', accent: 'bg-sky-400' },
  { id: 'review', title: 'Para revisar', empty: 'Nada pendiente de revisión', accent: 'bg-amber-400' },
  { id: 'idle', title: 'Sin cambios', empty: 'Sin tareas en espera', accent: 'bg-zinc-500' },
];

/** La columna se deriva del estado real (agente + git): no hay estado que sincronizar. */
export function columnOf(wt: WorktreeSummary): Column {
  const state = agentState(wt);
  if (state === 'waiting') return 'waiting';
  if (state === 'working') return 'running';
  if (wt.status && (wt.status.dirty || wt.status.ahead > 0)) return 'review';
  return 'idle';
}

export function Board({ worktrees, onOpen }: { worktrees: WorktreeSummary[]; onOpen: (id: string) => void }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {COLUMNS.map((col) => {
        const items = worktrees.filter((w) => columnOf(w) === col.id);
        return (
          <section key={col.id} className="flex min-h-48 flex-col rounded-xl border border-zinc-800 bg-zinc-900/40">
            <header className="flex items-center gap-2 px-4 py-3 text-sm font-medium text-zinc-300">
              <span className={`size-2 rounded-full ${col.accent}`} />
              {col.title}
              <span className="ml-auto rounded-full bg-zinc-800 px-2 text-xs text-zinc-400">{items.length}</span>
            </header>
            <div className="flex flex-1 flex-col gap-2 px-3 pb-3">
              {items.length === 0 ? <p className="px-1 py-6 text-center text-xs text-zinc-600">{col.empty}</p> : null}
              {items.map((wt) => (
                <TaskCard key={wt.id} wt={wt} onOpen={() => onOpen(wt.id)} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function TaskCard({ wt, onOpen }: { wt: WorktreeSummary; onOpen: () => void }) {
  const s = wt.status;
  const state = agentState(wt);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-left transition-colors hover:border-zinc-600 ${
        state === 'waiting' ? 'attention' : ''
      }`}
    >
      <div className="flex items-start gap-2">
        <span className="line-clamp-2 flex-1 text-sm font-medium text-zinc-100 first-letter:uppercase">
          {taskTitle(wt)}
        </span>
        {state === 'working' ? (
          <span className="flex items-center gap-1 text-xs text-sky-400" title="Agente trabajando">
            <Bot className="size-3.5 animate-pulse" />
          </span>
        ) : null}
        {state === 'waiting' ? (
          <span className="flex items-center gap-1 text-xs font-medium text-amber-300" title="El agente espera tu respuesta">
            <Hand className="size-3.5" />
            Te espera
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex items-center gap-1.5 font-mono text-xs text-zinc-500">
        <GitBranch className="size-3.5 shrink-0" />
        <span className="truncate">{wt.branch ?? 'detached'}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
        {wt.baseBranch ? <Chip>← {wt.baseBranch}</Chip> : null}
        {s && s.ahead > 0 ? (
          <Chip title="Commits por delante de la base">
            <ArrowUp className="size-3" />
            {s.ahead}
          </Chip>
        ) : null}
        {s && s.behind > 0 ? (
          <Chip title="Commits por detrás de la base" className="text-amber-400">
            <ArrowDown className="size-3" />
            {s.behind}
          </Chip>
        ) : null}
        {s?.dirty ? (
          <Chip title="Cambios sin commitear" className="text-amber-300">
            <CircleDot className="size-3" />
            sin commitear
          </Chip>
        ) : null}
      </div>
    </button>
  );
}

function Chip({ children, title, className = '' }: { children: React.ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-0.5 rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400 ${className}`}>
      {children}
    </span>
  );
}
