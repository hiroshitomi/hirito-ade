import { Bot, CircleCheck, GitBranch, Hand, Maximize2, Plus, Square, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { WorktreeSummary } from '@ade/shared';
import { api } from '../api/client';
import { agentState, taskTitle, type AgentState } from '../lib/agentState';
import { ModeBadge } from './AgentMode';
import { AgentTerminal } from './AgentTerminal';
import { CodeState, RepoBadge } from './CodeState';
import { Button } from './ui';

/**
 * Máximo de terminales a la vez. Además de por espacio: cada terminal mantiene un
 * stream SSE abierto y el navegador limita a 6 conexiones HTTP/1.1 por host
 * (4 terminales + /api/events dejan una libre para las peticiones normales).
 */
export const MAX_PANES = 4;
const STORAGE_KEY = 'ade.terminalSlots';

interface Props {
  worktrees: WorktreeSummary[];
  onOpen: (id: string) => void;
  onNewTask: () => void;
  onChanged: () => void;
}

/**
 * Vista "Terminales": hasta 4 agentes en paralelo, como tener varias terminales
 * abiertas. Los huecos libres se rellenan solos con agentes en ejecución; el
 * usuario puede fijar qué tarea va en cada panel.
 */
export function TerminalGrid({ worktrees, onOpen, onNewTask, onChanged }: Props) {
  const [pinned, setPinned] = useState<(string | null)[]>(loadSlots);
  // Quitados a mano: no vuelven por autorrelleno hasta que el usuario los elija otra vez.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pinned));
    } catch {
      // Sin almacenamiento (modo privado): las posiciones simplemente no se recuerdan.
    }
  }, [pinned]);

  const byId = useMemo(() => new Map(worktrees.map((w) => [w.id, w])), [worktrees]);
  const withAgent = worktrees.filter((w) => w.agent);

  // Paneles fijados que siguen existiendo + autorrelleno con agentes activos (por antigüedad).
  const slots = useMemo(() => {
    const result = pinned.map((id) => (id && byId.get(id)?.agent ? id : null));
    const shown = new Set(result.filter(Boolean));
    const candidates = worktrees
      .filter((w) => w.agent?.status === 'running' && !shown.has(w.id) && !dismissed.has(w.id))
      .sort((a, b) => a.agent!.startedAt.localeCompare(b.agent!.startedAt));
    for (let i = 0; i < MAX_PANES && candidates.length; i++) {
      if (result[i] == null) result[i] = candidates.shift()!.id;
    }
    // Compacta: los paneles ocupados primero, para que 2 agentes usen 2 columnas y no una cuadrícula a medias.
    return result.filter((id): id is string => id != null).slice(0, MAX_PANES);
  }, [pinned, byId, worktrees, dismissed]);

  const hidden = withAgent.filter((w) => w.agent!.status === 'running' && !slots.includes(w.id));

  function assign(index: number, id: string | null) {
    const previous = slots[index];
    setDismissed((d) => {
      const next = new Set(d);
      if (id) next.delete(id);
      else if (previous) next.add(previous);
      return next;
    });
    setPinned(() => {
      const next: (string | null)[] = [...slots];
      const existing = id ? next.indexOf(id) : -1;
      if (existing !== -1) next[existing] = next[index] ?? null; // intercambio si ya estaba visible
      next[index] = id;
      return next;
    });
  }

  if (slots.length === 0) {
    return (
      <div className="flex h-[calc(100vh-10rem)] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-zinc-800 text-center">
        <Bot className="size-8 text-zinc-600" />
        <p className="text-sm text-zinc-400">No hay agentes en ejecución.</p>
        <Button variant="primary" onClick={onNewTask}>
          <Plus className="size-4" />
          Nueva tarea
        </Button>
      </div>
    );
  }

  const layout =
    slots.length === 1 ? 'grid-cols-1 grid-rows-1' : slots.length === 2 ? 'grid-cols-2 grid-rows-1' : 'grid-cols-2 grid-rows-2';

  return (
    <div className="flex h-[calc(100vh-10rem)] flex-col gap-2">
      {hidden.length > 0 ? (
        <p className="text-xs text-zinc-500">
          {hidden.length} agente{hidden.length === 1 ? '' : 's'} más en ejecución fuera de la vista. Cámbialos desde el
          título de un panel. {hidden.some((w) => agentState(w) === 'waiting') ? (
            <span className="font-medium text-amber-300">Alguno te está esperando.</span>
          ) : null}
        </p>
      ) : null}
      <div className={`grid min-h-0 flex-1 gap-2 ${layout}`}>
        {slots.map((id, i) => (
          <Pane
            key={id}
            wt={byId.get(id)!}
            choices={withAgent}
            onSwap={(next) => assign(i, next)}
            onClose={() => assign(i, null)}
            onOpen={() => onOpen(id)}
            onChanged={onChanged}
          />
        ))}
      </div>
    </div>
  );
}

const STATE_LABEL: Record<AgentState, { text: string; className: string; Icon: typeof Bot }> = {
  waiting: { text: 'Te espera', className: 'text-amber-300', Icon: Hand },
  working: { text: 'Trabajando', className: 'text-sky-400', Icon: Bot },
  finished: { text: 'Terminado', className: 'text-zinc-500', Icon: CircleCheck },
  none: { text: 'Sin agente', className: 'text-zinc-500', Icon: Bot },
};

function Pane(props: {
  wt: WorktreeSummary;
  choices: WorktreeSummary[];
  onSwap: (id: string) => void;
  onClose: () => void;
  onOpen: () => void;
  onChanged: () => void;
}) {
  const { wt } = props;
  const state = agentState(wt);
  const label = STATE_LABEL[state];
  const run = wt.agent!;

  return (
    <section
      className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-zinc-950 ${
        state === 'waiting' ? 'attention' : 'border-zinc-800'
      }`}
    >
      <header className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/70 px-2 py-1.5 text-sm">
        <span className={`flex shrink-0 items-center gap-1 text-xs font-medium ${label.className}`}>
          <label.Icon className={`size-3.5 ${state === 'working' ? 'animate-pulse' : ''}`} />
          {label.text}
        </span>
        <select
          title="Cambiar la tarea de este panel"
          className="min-w-0 flex-1 truncate rounded bg-transparent px-1 py-0.5 font-medium text-zinc-100 first-letter:uppercase hover:bg-zinc-800 focus:outline-none"
          value={wt.id}
          onChange={(e) => props.onSwap(e.target.value)}
        >
          {props.choices.map((c) => (
            <option key={c.id} value={c.id} className="bg-zinc-900">
              {taskTitle(c)}
              {/* El panel actual ya lo indica en su etiqueta; en el resto ayuda a elegir. */}
              {c.id !== wt.id && agentState(c) === 'waiting' ? '  · te espera' : ''}
            </option>
          ))}
        </select>
        <ModeBadge mode={run.mode} />
        <div className="flex shrink-0 items-center">
          {run.status === 'running' ? (
            <IconButton title="Detener agente" onClick={() => void api.stopAgent(run.id).then(props.onChanged)}>
              <Square className="size-3.5" />
            </IconButton>
          ) : null}
          <IconButton title="Abrir tarea (cambios, fusionar…)" onClick={props.onOpen}>
            <Maximize2 className="size-3.5" />
          </IconButton>
          <IconButton title="Quitar de la vista" onClick={props.onClose}>
            <X className="size-3.5" />
          </IconButton>
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <AgentTerminal key={run.id} run={run} fontSize={12} onExit={props.onChanged} />
      </div>
      {/* Estado del código de este worktree: cada agente trabaja en su propia rama. */}
      <footer className="flex items-center gap-3 border-t border-zinc-800 bg-zinc-900/70 px-2 py-1">
        <RepoBadge repo={wt.repo} />
        <span className="flex shrink-0 items-center gap-1 font-mono text-xs text-zinc-500" title={wt.path}>
          <GitBranch className="size-3" />
          {wt.branch} {wt.baseBranch ? `← ${wt.baseBranch}` : ''}
        </span>
        <CodeState wt={wt} className="min-w-0" />
      </footer>
    </section>
  );
}

function IconButton(props: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={props.title}
      onClick={props.onClick}
      className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
    >
      {props.children}
    </button>
  );
}

function loadSlots(): (string | null)[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string | null => typeof x === 'string' || x === null) : [];
  } catch {
    return [];
  }
}
