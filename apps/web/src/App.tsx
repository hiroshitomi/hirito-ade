import { CheckCircle2, FolderGit2, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { AgentPresetInfo, MergeResult } from '@ade/shared';
import { api, errorMessage } from './api/client';
import { Board } from './components/Board';
import { NewTaskDialog } from './components/NewTaskDialog';
import { TaskDetail } from './components/TaskDetail';
import { Button } from './components/ui';
import { usePolling } from './hooks/usePolling';

interface Health {
  repoRoot: string;
}

export function App() {
  const { data: worktrees, error, loading, refresh } = usePolling(api.listWorktrees, 3000);
  const [presets, setPresets] = useState<AgentPresetInfo[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    api.listPresets().then(setPresets).catch(() => undefined);
    fetch('/api/health')
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const refreshNow = useCallback(() => void refresh(), [refresh]);
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
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">ADE</h1>
          {health ? (
            <p className="flex items-center gap-1.5 font-mono text-xs text-zinc-500">
              <FolderGit2 className="size-3.5" />
              {health.repoRoot}
            </p>
          ) : null}
        </div>
        <Button variant="primary" className="ml-auto" onClick={() => setCreating(true)} disabled={!!error && !worktrees}>
          <Plus className="size-4" />
          Nueva tarea
        </Button>
      </header>

      {error ? (
        <p className="mb-4 rounded-md bg-rose-950/60 px-3 py-2 text-sm text-rose-300">
          No se puede conectar con el servidor ADE: {errorMessage(error)}
        </p>
      ) : null}

      {worktrees ? <Board worktrees={worktrees} onOpen={setOpenId} /> : null}
      {loading && !worktrees ? <p className="text-sm text-zinc-500">Cargando…</p> : null}

      {creating ? (
        <NewTaskDialog
          presets={presets}
          onClose={() => setCreating(false)}
          onCreated={async (wt) => {
            setCreating(false);
            await refresh();
            setOpenId(wt.id);
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
