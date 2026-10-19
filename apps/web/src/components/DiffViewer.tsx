import { html as renderDiff } from 'diff2html';
import type { ColorSchemeType, OutputFormatType } from 'diff2html/lib/types';
import { Columns2, FileDiff, RefreshCw, Rows3 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api, errorMessage } from '../api/client';
import { usePolling } from '../hooks/usePolling';

interface Props {
  worktreeId: string;
  /** Mientras el agente trabaja, el diff se refresca solo. */
  live: boolean;
}

const STATUS_STYLE: Record<string, string> = {
  A: 'text-emerald-400',
  M: 'text-amber-400',
  D: 'text-rose-400',
};

export function DiffViewer({ worktreeId, live }: Props) {
  const [format, setFormat] = useState<'line-by-line' | 'side-by-side'>('line-by-line');
  const { data: diff, error, loading, refresh } = usePolling(() => api.getDiff(worktreeId), live ? 4000 : 0, [
    worktreeId,
    live,
  ]);

  // diff2html escapa el contenido del patch, por eso es seguro inyectar su HTML.
  const html = useMemo(
    () =>
      diff?.patch
        ? renderDiff(diff.patch, {
            drawFileList: false,
            matching: 'lines',
            outputFormat: format as OutputFormatType,
            colorScheme: 'dark' as ColorSchemeType,
          })
        : '',
    [diff?.patch, format],
  );

  const totals = diff?.files.reduce(
    (acc, f) => ({ add: acc.add + (f.additions ?? 0), del: acc.del + (f.deletions ?? 0) }),
    { add: 0, del: 0 },
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2 text-sm">
        <FileDiff className="size-4 text-zinc-400" />
        {diff ? (
          <span className="text-zinc-300">
            {diff.files.length} fichero{diff.files.length === 1 ? '' : 's'} vs <code>{diff.baseBranch}</code>
            <span className="ml-2 text-emerald-400">+{totals?.add}</span>
            <span className="ml-1 text-rose-400">−{totals?.del}</span>
          </span>
        ) : (
          <span className="text-zinc-500">{loading ? 'Cargando…' : ''}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <IconToggle active={format === 'line-by-line'} onClick={() => setFormat('line-by-line')} title="Unificado">
            <Rows3 className="size-4" />
          </IconToggle>
          <IconToggle active={format === 'side-by-side'} onClick={() => setFormat('side-by-side')} title="Lado a lado">
            <Columns2 className="size-4" />
          </IconToggle>
          <IconToggle onClick={() => void refresh()} title="Refrescar">
            <RefreshCw className="size-4" />
          </IconToggle>
        </div>
      </div>

      {error ? <p className="p-4 text-sm text-rose-400">{errorMessage(error)}</p> : null}

      {diff && diff.files.length === 0 ? (
        <p className="p-8 text-center text-sm text-zinc-500">Todavía no hay cambios en este worktree.</p>
      ) : null}

      {diff && diff.files.length > 0 ? (
        <div className="flex min-h-0 flex-1">
          <ul className="w-64 shrink-0 overflow-y-auto border-r border-zinc-800 py-2 text-xs">
            {diff.files.map((f) => (
              <li key={f.path} className="flex items-center gap-2 px-3 py-1 font-mono" title={f.path}>
                <span className={`w-3 font-bold ${STATUS_STYLE[f.status] ?? 'text-zinc-400'}`}>{f.status}</span>
                <span className="truncate text-zinc-300">{f.path}</span>
              </li>
            ))}
          </ul>
          <div className="min-w-0 flex-1 overflow-auto p-3 text-xs" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      ) : null}
    </div>
  );
}

function IconToggle(props: { active?: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={props.title}
      onClick={props.onClick}
      className={`rounded p-1.5 hover:bg-zinc-800 ${props.active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400'}`}
    >
      {props.children}
    </button>
  );
}
