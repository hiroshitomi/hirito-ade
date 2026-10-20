import { CornerLeftUp, Folder, FolderGit2, FolderOpen, HardDrive, History, House, Layers } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FolderListing, ProjectInfo, RecentProject } from '@ade/shared';
import { api, errorMessage } from '../api/client';
import { Button, ErrorText, inputClass, Modal } from './ui';

interface Props {
  recent: RecentProject[];
  onOpened: (project: ProjectInfo) => void;
  /** Carpeta donde empieza el navegador (por defecto, junto al proyecto más reciente). */
  startPath?: string;
}

/**
 * Elegir el proyecto: el diálogo de carpetas del sistema ("Examinar…"), un navegador
 * integrado (siempre disponible, también si no hay diálogo nativo), pegar una ruta o
 * reabrir uno reciente. Vale la carpeta de un repo o la que agrupa varios (workspace).
 */
export function OpenProjectPanel({ recent, onOpened, startPath }: Props) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const open = (path: string) => run(async () => onOpened(await api.openProject(path)));
  const browse = (path?: string) => run(async () => setListing(await api.browseFolders(path)));

  async function examine() {
    setNote(null);
    await run(async () => {
      const res = await api.pickFolder();
      if (res.status === 'picked') onOpened(await api.openProject(res.path));
      else if (res.status === 'unsupported') {
        setNote('Este sistema no tiene un selector de carpetas disponible: usa el navegador de abajo.');
        setListing(await api.browseFolders());
      }
    });
  }

  // El navegador arranca en la carpeta personal (o en la del último proyecto).
  useEffect(() => {
    const start = startPath ?? (recent[0] ? parentOf(recent[0].path) : undefined);
    void api
      .browseFolders(start)
      .then(setListing)
      .catch(() => api.browseFolders().then(setListing));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => void examine()} disabled={busy}>
          <FolderOpen className="size-4" />
          Examinar…
        </Button>
        <span className="text-zinc-500">o pega la ruta:</span>
        <form
          className="flex min-w-64 flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) void open(typed.trim());
          }}
        >
          <input
            className={`${inputClass} font-mono text-xs`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="C:\Users\tu\proyectos\sys-cloud"
          />
          <Button type="submit" disabled={busy || !typed.trim()}>
            Abrir
          </Button>
        </form>
      </div>
      <p className="text-xs text-zinc-500">
        Elige la carpeta de un repositorio, o la carpeta que agrupa varios (front, back, microservicios…): ADE detecta los
        repos que contiene y sus <code>.claude/skills</code>.
      </p>

      {note ? <p className="rounded-md bg-zinc-800/60 px-3 py-2 text-xs text-zinc-300">{note}</p> : null}
      <ErrorText>{error}</ErrorText>

      {recent.length ? (
        <section>
          <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium tracking-wide text-zinc-400 uppercase">
            <History className="size-3.5" />
            Recientes
          </h3>
          <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
            {recent.map((r) => (
              <li key={r.path}>
                <button
                  type="button"
                  onClick={() => void open(r.path)}
                  disabled={busy}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-zinc-800/60"
                >
                  {r.kind === 'workspace' ? (
                    <Layers className="size-4 shrink-0 text-indigo-300" />
                  ) : (
                    <FolderGit2 className="size-4 shrink-0 text-indigo-300" />
                  )}
                  <span className="font-medium text-zinc-100">{r.name}</span>
                  <span className="min-w-0 truncate font-mono text-xs text-zinc-500">{r.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {listing ? <FolderBrowser listing={listing} busy={busy} onNavigate={browse} onOpen={open} /> : null}
    </div>
  );
}

function FolderBrowser(props: {
  listing: FolderListing;
  busy: boolean;
  onNavigate: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const { listing } = props;
  const openable = listing.isRepo || listing.repoCount > 0;
  return (
    <section className="overflow-hidden rounded-lg border border-zinc-800">
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-900/70 px-3 py-2">
        {listing.roots.map((r) => (
          <button
            key={r.path}
            type="button"
            onClick={() => props.onNavigate(r.path)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            {r.name === 'Carpeta personal' ? <House className="size-3.5" /> : <HardDrive className="size-3.5" />}
            {r.name}
          </button>
        ))}
      </header>
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <button
          type="button"
          title="Subir un nivel"
          disabled={!listing.parent}
          onClick={() => listing.parent && props.onNavigate(listing.parent)}
          className="rounded p-1 text-zinc-400 hover:bg-zinc-800 disabled:opacity-30"
        >
          <CornerLeftUp className="size-4" />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300" title={listing.path}>
          {listing.path}
        </span>
        <span className="hidden text-xs text-zinc-500 sm:inline">
          {listing.isRepo
            ? 'repositorio git'
            : listing.repoCount
              ? `workspace · ${listing.repoCount} repo${listing.repoCount === 1 ? '' : 's'}`
              : 'sin repos'}
        </span>
        <Button variant="primary" onClick={() => props.onOpen(listing.path)} disabled={props.busy || !openable}>
          Abrir esta carpeta
        </Button>
      </div>
      <ul className="max-h-72 overflow-y-auto py-1">
        {listing.entries.length === 0 ? <li className="px-3 py-2 text-xs text-zinc-500">Sin subcarpetas</li> : null}
        {listing.entries.map((e) => (
          <li key={e.path}>
            <button
              type="button"
              onClick={() => props.onNavigate(e.path)}
              onDoubleClick={() => e.isRepo && props.onOpen(e.path)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800/60"
              title={e.isRepo ? 'Repositorio git (doble clic para abrirlo)' : undefined}
            >
              {e.isRepo ? (
                <FolderGit2 className="size-4 shrink-0 text-emerald-400" />
              ) : (
                <Folder className="size-4 shrink-0 text-zinc-500" />
              )}
              <span className={e.isRepo ? 'text-zinc-100' : 'text-zinc-300'}>{e.name}</span>
              {e.isRepo ? <span className="text-xs text-emerald-400/80">git</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Pantalla inicial cuando no hay proyecto abierto. */
export function WelcomeScreen(props: Props) {
  return (
    <div className="mx-auto mt-10 max-w-3xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Abre un proyecto</h1>
        <p className="text-sm text-zinc-400">
          ADE lanza agentes en paralelo sobre tus repositorios, cada uno en su propia rama y carpeta de trabajo.
        </p>
      </div>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <OpenProjectPanel {...props} />
      </div>
    </div>
  );
}

/** Para cambiar de proyecto desde la cabecera. */
export function OpenProjectDialog(props: Props & { onClose: () => void }) {
  return (
    <Modal title="Abrir proyecto" onClose={props.onClose} size="xl">
      <OpenProjectPanel recent={props.recent} onOpened={props.onOpened} startPath={props.startPath} />
    </Modal>
  );
}

function parentOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : p;
}
