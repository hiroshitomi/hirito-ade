import { ArrowLeft, GitBranch, GitMerge, Play, Square, SquareTerminal, Trash2, FileDiff } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { AgentPresetInfo, AgentRunInfo, MergeResult, MergeStrategy, WorktreeSummary } from '@ade/shared';
import { api, errorMessage } from '../api/client';
import { AgentTerminal } from './AgentTerminal';
import { taskTitle } from './Board';
import { Button, ErrorText, Field, fieldClass, inputClass, Modal } from './ui';

// diff2html (con highlight.js) es la mayor parte del bundle: solo se carga al abrir "Cambios".
const DiffViewer = lazy(() => import('./DiffViewer').then((m) => ({ default: m.DiffViewer })));

interface Props {
  worktree: WorktreeSummary;
  presets: AgentPresetInfo[];
  onClose: () => void;
  /** Tras una acción que cambia el estado (lanzar, parar…), para refrescar el tablero. */
  onChanged: () => void;
  onMerged: (result: MergeResult) => void;
  onDiscarded: () => void;
}

type Tab = 'terminal' | 'diff';

export function TaskDetail({ worktree, presets, onClose, onChanged, onMerged, onDiscarded }: Props) {
  const [tab, setTab] = useState<Tab>('terminal');
  const [run, setRun] = useState<AgentRunInfo | null>(null);
  const [runsLoaded, setRunsLoaded] = useState(false);
  const [dialog, setDialog] = useState<'merge' | 'discard' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const running = run?.status === 'running';

  // La última ejecución del agente en este worktree (la API las devuelve en orden de creación).
  useEffect(() => {
    let cancelled = false;
    api
      .listAgents(worktree.id)
      .then((runs) => !cancelled && setRun(runs.at(-1) ?? null))
      .catch((err) => !cancelled && setError(errorMessage(err)))
      .finally(() => !cancelled && setRunsLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [worktree.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !dialog && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, onClose]);

  const handleExit = useCallback(
    (finished: AgentRunInfo) => {
      setRun(finished);
      onChanged();
    },
    [onChanged],
  );

  async function stop() {
    if (!run) return;
    setError(null);
    try {
      setRun(await api.stopAgent(run.id));
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-zinc-950">
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-4 py-3">
        <Button variant="ghost" onClick={onClose} title="Volver (Esc)">
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0">
          <h1 className="truncate font-semibold first-letter:uppercase">{taskTitle(worktree)}</h1>
          <p className="flex items-center gap-1.5 font-mono text-xs text-zinc-500">
            <GitBranch className="size-3.5" />
            {worktree.branch} {worktree.baseBranch ? `← ${worktree.baseBranch}` : ''}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {running ? (
            <Button onClick={stop}>
              <Square className="size-4" />
              Detener agente
            </Button>
          ) : null}
          <Button variant="danger" onClick={() => setDialog('discard')}>
            <Trash2 className="size-4" />
            Descartar
          </Button>
          <Button
            variant="primary"
            onClick={() => setDialog('merge')}
            disabled={running}
            title={running ? 'Detén el agente antes de fusionar' : undefined}
          >
            <GitMerge className="size-4" />
            Aprobar y fusionar
          </Button>
        </div>
      </header>

      {error ? (
        <div className="px-4 pt-3">
          <ErrorText>{error}</ErrorText>
        </div>
      ) : null}

      <nav className="flex gap-1 border-b border-zinc-800 px-4">
        <TabButton active={tab === 'terminal'} onClick={() => setTab('terminal')}>
          <SquareTerminal className="size-4" />
          Terminal
          {running ? <span className="size-1.5 animate-pulse rounded-full bg-sky-400" /> : null}
        </TabButton>
        <TabButton active={tab === 'diff'} onClick={() => setTab('diff')}>
          <FileDiff className="size-4" />
          Cambios
        </TabButton>
      </nav>

      <main className="min-h-0 flex-1">
        {/* La terminal se mantiene montada al cambiar de pestaña para no perder scroll ni stream. */}
        <div className={tab === 'terminal' ? 'flex h-full flex-col' : 'hidden'}>
          {runsLoaded && !running ? (
            <LaunchBar
              presets={presets}
              hasPrevious={run !== null}
              onLaunch={async (preset, prompt) => {
                setError(null);
                try {
                  setRun(await api.startAgent({ worktreeId: worktree.id, preset, prompt }));
                  onChanged();
                } catch (err) {
                  setError(errorMessage(err));
                }
              }}
            />
          ) : null}
          <div className="min-h-0 flex-1">
            {run ? (
              <AgentTerminal key={run.id} run={run} onExit={handleExit} />
            ) : runsLoaded ? (
              <p className="p-8 text-center text-sm text-zinc-500">Ningún agente lanzado todavía en este worktree.</p>
            ) : null}
          </div>
        </div>
        {tab === 'diff' ? (
          <Suspense fallback={<p className="p-4 text-sm text-zinc-500">Cargando…</p>}>
            <DiffViewer worktreeId={worktree.id} live={running} />
          </Suspense>
        ) : null}
      </main>

      {dialog === 'merge' ? (
        <MergeDialog worktree={worktree} onClose={() => setDialog(null)} onMerged={onMerged} />
      ) : null}
      {dialog === 'discard' ? (
        <DiscardDialog worktree={worktree} onClose={() => setDialog(null)} onDiscarded={onDiscarded} />
      ) : null}
    </div>
  );
}

function TabButton(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${
        props.active ? 'border-indigo-500 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'
      }`}
    >
      {props.children}
    </button>
  );
}

function LaunchBar(props: {
  presets: AgentPresetInfo[];
  hasPrevious: boolean;
  onLaunch: (preset: string, prompt?: string) => Promise<void>;
}) {
  const [preset, setPreset] = useState(props.presets[0]?.id ?? '');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const acceptsPrompt = props.presets.find((p) => p.id === preset)?.acceptsPrompt ?? false;

  return (
    <form
      className="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-4 py-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await props.onLaunch(preset, acceptsPrompt ? prompt.trim() || undefined : undefined);
        setBusy(false);
        setPrompt('');
      }}
    >
      <select className={`${fieldClass} py-1.5`} value={preset} onChange={(e) => setPreset(e.target.value)}>
        {props.presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      {acceptsPrompt ? (
        <input
          className={`${fieldClass} min-w-48 flex-1 py-1.5`}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Instrucciones (opcional)"
        />
      ) : null}
      <Button variant="primary" type="submit" disabled={busy || !preset}>
        <Play className="size-4" />
        {props.hasPrevious ? 'Relanzar agente' : 'Lanzar agente'}
      </Button>
    </form>
  );
}

function MergeDialog(props: { worktree: WorktreeSummary; onClose: () => void; onMerged: (r: MergeResult) => void }) {
  const [strategy, setStrategy] = useState<MergeStrategy>('merge');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function merge() {
    setBusy(true);
    setError(null);
    try {
      props.onMerged(
        await api.mergeWorktree({ id: props.worktree.id, strategy, message: message.trim() || undefined }),
      );
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Aprobar y fusionar" onClose={props.onClose}>
      <div className="space-y-4">
        <p className="text-sm text-zinc-400">
          Se fusionará <code className="text-zinc-200">{props.worktree.branch}</code> en{' '}
          <code className="text-zinc-200">{props.worktree.baseBranch ?? 'la rama base'}</code>. Los cambios sin commitear se
          commitean automáticamente, y después se eliminan el worktree y la rama.
        </p>
        <Field label="Estrategia">
          <select className={inputClass} value={strategy} onChange={(e) => setStrategy(e.target.value as MergeStrategy)}>
            <option value="merge">Merge commit (conserva el historial del agente)</option>
            <option value="squash">Squash (un único commit)</option>
          </select>
        </Field>
        <Field label="Mensaje del commit" hint="Opcional">
          <input className={inputClass} value={message} onChange={(e) => setMessage(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={props.onClose}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={merge} disabled={busy}>
            <GitMerge className="size-4" />
            {busy ? 'Fusionando…' : 'Fusionar'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function DiscardDialog(props: { worktree: WorktreeSummary; onClose: () => void; onDiscarded: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function discard() {
    setBusy(true);
    setError(null);
    try {
      // force: descartar es explícito, los cambios sin commitear se pierden.
      await api.removeWorktree(props.worktree.id, { force: true });
      props.onDiscarded();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Descartar tarea" onClose={props.onClose}>
      <div className="space-y-4">
        <p className="text-sm text-zinc-400">
          Se detendrá el agente y se eliminarán el worktree y la rama{' '}
          <code className="text-zinc-200">{props.worktree.branch}</code>.{' '}
          <strong className="text-rose-300">Los cambios no fusionados se perderán.</strong>
        </p>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={props.onClose}>
            Cancelar
          </Button>
          <Button variant="danger" onClick={discard} disabled={busy}>
            <Trash2 className="size-4" />
            {busy ? 'Descartando…' : 'Descartar'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
