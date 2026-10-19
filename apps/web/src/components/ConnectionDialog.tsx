import { CircleAlert, CircleCheck, LogIn, LogOut, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { AgentRunInfo } from '@ade/shared';
import { errorMessage } from '../api/client';
import { AgentTerminal } from './AgentTerminal';
import { Button, ErrorText, Modal } from './ui';

export type Tone = 'ok' | 'warn' | 'error';

export const TONE_CLASS: Record<Tone, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  error: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
};
export const TONE_ICON = { ok: CircleCheck, warn: TriangleAlert, error: CircleAlert };

export interface ConnectionView {
  tone: Tone;
  headline: string;
  explanation: string;
  rows: [label: string, value: ReactNode][];
  notes?: ReactNode;
  canLogin: boolean;
  canLogout: boolean;
}

interface Props {
  title: string;
  /** null mientras se comprueba por primera vez. */
  view: ConnectionView | null;
  loginLabel: string;
  loginHint: ReactNode;
  onRecheck: () => Promise<void>;
  onLogin: () => Promise<AgentRunInfo>;
  onLogout: () => Promise<void>;
  onClose: () => void;
}

/**
 * Diálogo común para conectar una cuenta (Claude, GitHub…). El login lo hace el
 * CLI oficial de cada servicio dentro de una terminal integrada: ADE nunca
 * maneja credenciales, solo muestra la terminal y vuelve a comprobar el estado.
 */
export function ConnectionDialog(props: Props) {
  const [loginRun, setLoginRun] = useState<AgentRunInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const recheck = () => run(props.onRecheck);

  // Al abrir: puede que hayas iniciado sesión desde otra terminal.
  useEffect(() => {
    void recheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { view } = props;
  const loginActive = loginRun?.status === 'running';
  const Icon = view ? TONE_ICON[view.tone] : null;

  return (
    <Modal title={props.title} onClose={props.onClose} size="xl">
      <div className="space-y-4 text-sm">
        {view && Icon ? (
          <div className={`flex items-start gap-3 rounded-lg border p-3 ${TONE_CLASS[view.tone]}`}>
            <Icon className="mt-0.5 size-4 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">{view.headline}</p>
              <p className="text-zinc-300">{view.explanation}</p>
            </div>
          </div>
        ) : (
          <p className="text-zinc-500">Comprobando…</p>
        )}

        {view?.rows.length ? (
          <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5 text-zinc-400">
            {view.rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt>{label}</dt>
                <dd className="min-w-0 truncate text-zinc-200">{value ?? '—'}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {view?.notes}

        {loginRun ? (
          <div className="space-y-2">
            <p className="text-xs text-zinc-400">{props.loginHint}</p>
            <div className="h-64 overflow-hidden rounded-md border border-zinc-800">
              <AgentTerminal
                key={loginRun.id}
                run={loginRun}
                fontSize={12}
                onExit={(finished) => {
                  setLoginRun(finished);
                  void recheck();
                }}
              />
            </div>
          </div>
        ) : null}

        <ErrorText>{error}</ErrorText>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => void recheck()} disabled={busy}>
            <RefreshCw className={`size-4 ${busy ? 'animate-spin' : ''}`} />
            Volver a comprobar
          </Button>
          {view?.canLogout ? (
            <Button onClick={() => void run(props.onLogout)} disabled={busy || loginActive}>
              <LogOut className="size-4" />
              Cerrar sesión
            </Button>
          ) : null}
          {view?.canLogin ? (
            <Button
              variant="primary"
              onClick={() => void run(async () => setLoginRun(await props.onLogin()))}
              disabled={busy || loginActive}
            >
              <LogIn className="size-4" />
              {loginActive ? 'Esperando autorización…' : props.loginLabel}
            </Button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
