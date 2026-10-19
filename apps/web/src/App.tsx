import { Bell, BellOff, CheckCircle2, Grid2x2, KanbanSquare, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { AgentPresetInfo, AgentRunInfo, ClaudeAuthStatus, ClaudeUsage, GitHubAuthStatus, MergeResult } from '@ade/shared';
import { api, errorMessage } from './api/client';
import { Board } from './components/Board';
import { ClaudeAccountDialog } from './components/ClaudeAccount';
import { GitHubAccountDialog } from './components/GitHubAccount';
import { NewTaskDialog } from './components/NewTaskDialog';
import { TaskDetail } from './components/TaskDetail';
import { TerminalGrid } from './components/TerminalGrid';
import { ProjectSummary, StatusStrip } from './components/TopBar';
import { Button } from './components/ui';
import { useAgentEvents } from './hooks/useAgentEvents';
import { useNotifications } from './hooks/useNotifications';
import { usePolling } from './hooks/usePolling';
import { agentState, needsAttention, taskTitle } from './lib/agentState';

type View = 'board' | 'terminals';
const VIEW_KEY = 'ade.view';

export function App() {
  // El polling cubre cambios de git (ficheros editados); los de agentes llegan al instante por /api/events.
  const { data: worktrees, error, loading, refresh } = usePolling(api.listWorktrees, 3000);
  const { data: project, refresh: refreshProject } = usePolling(api.project, 10000);
  const [presets, setPresets] = useState<AgentPresetInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [view, setView] = useState<View>(loadView);
  const [claude, setClaude] = useState<ClaudeAuthStatus | null>(null);
  const [github, setGitHub] = useState<GitHubAuthStatus | null>(null);
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);
  const [accountOpen, setAccountOpen] = useState<'claude' | 'github' | null>(null);
  const notifications = useNotifications();

  useEffect(() => {
    api.listPresets().then(setPresets).catch(() => undefined);
    api.claudeStatus().then(setClaude).catch(() => undefined);
    api.githubStatus().then(setGitHub).catch(() => undefined);
    api.usage().then(setUsage).catch(() => undefined);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // Sin almacenamiento: la vista vuelve a "Tablero" al recargar.
    }
  }, [view]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const refreshNow = useCallback(() => void refresh(), [refresh]);

  const handleWaiting = useCallback(
    (run: AgentRunInfo) => {
      const wt = worktrees?.find((w) => w.id === run.worktreeId);
      if (!wt) return; // p.ej. la terminal de un login: no es una tarea
      const title = taskTitle(wt);
      notifications.notify(`ADE · ${title}`, 'El agente espera tu respuesta', run.id, () => setOpenId(run.worktreeId));
    },
    [worktrees, notifications],
  );
  useAgentEvents({ onAnyChange: refreshNow, onWaiting: handleWaiting, onUsage: setUsage });

  // "(2) ADE" en la pestaña: visible aunque estés en otra ventana.
  const waitingCount = worktrees?.filter(needsAttention).length ?? 0;
  const workingCount = worktrees?.filter((w) => agentState(w) === 'working').length ?? 0;
  useEffect(() => {
    const name = project?.name ? `ADE · ${project.name}` : 'ADE';
    document.title = waitingCount ? `(${waitingCount}) ${name} · te necesita` : name;
  }, [waitingCount, project?.name]);

  const closeDetail = useCallback(() => {
    setOpenId(null);
    void refresh(); // sin esperar al siguiente poll: el tablero refleja lo que acabas de ver
  }, [refresh]);
  const open = worktrees?.find((w) => w.id === openId) ?? null;

  function handleMerged(result: MergeResult) {
    setOpenId(null);
    setToast(
      result.status === 'up-to-date'
        ? `No había cambios que fusionar en ${result.targetBranch}`
        : `Fusionado en ${result.targetBranch} (${result.commit?.slice(0, 7)})`,
    );
    void refresh();
    void refreshProject(); // la rama principal avanzó
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 bg-zinc-950/95 backdrop-blur">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-800 px-4 py-2.5">
          <span className="rounded-md bg-indigo-600 px-2 py-1 text-sm font-bold tracking-tight">ADE</span>
          <ProjectSummary project={project} />

          <div className="ml-auto flex items-center gap-2">
            <div className="flex rounded-md border border-zinc-800 p-0.5" role="tablist" aria-label="Vista">
              <ViewTab active={view === 'board'} onClick={() => setView('board')} title="Tablero">
                <KanbanSquare className="size-4" />
                Tablero
              </ViewTab>
              <ViewTab active={view === 'terminals'} onClick={() => setView('terminals')} title="Hasta 4 terminales a la vez">
                <Grid2x2 className="size-4" />
                Terminales
              </ViewTab>
            </div>
            {notifications.permission === 'default' ? (
              <Button variant="ghost" onClick={() => void notifications.request()} title="Avisarme cuando un agente me necesite">
                <Bell className="size-4" />
                Activar avisos
              </Button>
            ) : notifications.permission === 'denied' ? (
              <span title="Notificaciones bloqueadas en el navegador" className="p-1.5 text-zinc-600">
                <BellOff className="size-4" />
              </span>
            ) : null}
            <Button variant="primary" onClick={() => setCreating(true)} disabled={!!error && !worktrees}>
              <Plus className="size-4" />
              Nueva tarea
            </Button>
          </div>
        </div>
        <StatusStrip
          claude={claude}
          usage={usage}
          github={github}
          working={workingCount}
          waiting={waitingCount}
          onOpenClaude={() => setAccountOpen('claude')}
          onOpenGitHub={() => setAccountOpen('github')}
        />
      </header>

      <main className={`flex-1 px-4 py-4 ${view === 'terminals' ? '' : 'mx-auto w-full max-w-7xl'}`}>
        {error ? (
          <p className="mb-4 rounded-md bg-rose-950/60 px-3 py-2 text-sm text-rose-300">
            No se puede conectar con el servidor ADE: {errorMessage(error)}
          </p>
        ) : null}

        {worktrees && view === 'board' ? <Board worktrees={worktrees} onOpen={setOpenId} /> : null}
        {/* Se desmonta con el detalle abierto: sus terminales liberan conexiones SSE (máx. 6 por host). */}
        {worktrees && view === 'terminals' && !open ? (
          <TerminalGrid
            worktrees={worktrees}
            onOpen={setOpenId}
            onNewTask={() => setCreating(true)}
            onChanged={refreshNow}
          />
        ) : null}
        {loading && !worktrees ? <p className="text-sm text-zinc-500">Cargando…</p> : null}
      </main>

      {creating ? (
        <NewTaskDialog
          presets={presets}
          claude={claude}
          onConnectClaude={() => setAccountOpen('claude')}
          onClose={() => setCreating(false)}
          onCreated={async (wt) => {
            setCreating(false);
            await refresh();
            // En la vista de terminales el agente nuevo aparece en un panel; no hace falta abrir el detalle.
            if (view === 'board') setOpenId(wt.id);
          }}
        />
      ) : null}

      {open ? (
        <TaskDetail
          key={open.id}
          worktree={open}
          presets={presets}
          onClose={closeDetail}
          onChanged={refreshNow}
          onMerged={handleMerged}
          onDiscarded={() => {
            setOpenId(null);
            setToast('Tarea descartada');
            void refresh();
          }}
        />
      ) : null}

      {accountOpen === 'claude' ? (
        <ClaudeAccountDialog status={claude} onStatus={setClaude} onClose={() => setAccountOpen(null)} />
      ) : null}
      {accountOpen === 'github' ? (
        <GitHubAccountDialog
          status={github}
          project={project}
          onStatus={setGitHub}
          onClose={() => setAccountOpen(null)}
        />
      ) : null}

      {toast ? (
        <div className="fixed right-4 bottom-4 z-50 flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm shadow-xl">
          <CheckCircle2 className="size-4 text-emerald-400" />
          {toast}
          <button type="button" className="ml-2 text-zinc-500 hover:text-zinc-300" onClick={() => setToast(null)}>
            <X className="size-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ViewTab(props: { active: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.active}
      title={props.title}
      onClick={props.onClick}
      className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-sm ${
        props.active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
      }`}
    >
      {props.children}
    </button>
  );
}

function loadView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'terminals' ? 'terminals' : 'board';
  } catch {
    return 'board';
  }
}
