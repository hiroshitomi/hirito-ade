import { CircleAlert, CircleCheck, LogIn, LogOut, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AgentRunInfo, ClaudeAuthStatus } from '@ade/shared';
import { api, errorMessage } from '../api/client';
import { AgentTerminal } from './AgentTerminal';
import { Button, ErrorText, Modal } from './ui';

type Tone = 'ok' | 'warn' | 'error';

/** Resumen corto para el indicador de la cabecera. */
export function claudeSummary(s: ClaudeAuthStatus): { tone: Tone; label: string } {
  if (!s.installed) return { tone: 'error', label: 'Claude Code no instalado' };
  if (!s.loggedIn) return { tone: 'warn', label: 'Conectar Claude' };
  if (!s.usesSubscription) return { tone: 'warn', label: 'Claude · API (pago por uso)' };
  return { tone: 'ok', label: `Claude · ${planName(s.subscriptionType)}` };
}

const TONE: Record<Tone, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  error: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
};
const TONE_ICON = { ok: CircleCheck, warn: TriangleAlert, error: CircleAlert };

export function ClaudeAccountChip({ status, onClick }: { status: ClaudeAuthStatus | null; onClick: () => void }) {
  if (!status) return null;
  const { tone, label } = claudeSummary(status);
  const Icon = TONE_ICON[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      title={status.email ?? 'Cuenta de Claude'}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${TONE[tone]}`}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  );
}

interface DialogProps {
  status: ClaudeAuthStatus | null;
  onClose: () => void;
  onStatus: (s: ClaudeAuthStatus) => void;
}

/**
 * Conecta Claude Code con tu suscripción usando el login oficial del CLI
 * (`claude auth login --claudeai`) en una terminal integrada: ADE nunca ve ni
 * guarda tus credenciales, quedan donde Claude Code las guarda siempre.
 */
export function ClaudeAccountDialog({ status, onClose, onStatus }: DialogProps) {
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

  const recheck = () => run(async () => onStatus(await api.claudeStatus()));

  // Al abrir: puede que hayas iniciado sesión desde otra terminal.
  useEffect(() => {
    void recheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const login = () => run(async () => setLoginRun(await api.claudeLogin()));
  const logout = () => run(async () => onStatus(await api.claudeLogout()));

  const summary = status ? claudeSummary(status) : null;
  const loginActive = loginRun?.status === 'running';

  return (
    <Modal title="Cuenta de Claude" onClose={onClose} size="xl">
      <div className="space-y-4 text-sm">
        {status && summary ? (
          <div className={`flex items-start gap-3 rounded-lg border p-3 ${TONE[summary.tone]}`}>
            {(() => {
              const Icon = TONE_ICON[summary.tone];
              return <Icon className="mt-0.5 size-4 shrink-0" />;
            })()}
            <div className="space-y-1">
              <p className="font-medium">{headline(status)}</p>
              <p className="text-zinc-300">{explanation(status)}</p>
            </div>
          </div>
        ) : (
          <p className="text-zinc-500">Comprobando…</p>
        )}

        {status?.installed ? (
          <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5 text-zinc-400">
            <dt>Cuenta</dt>
            <dd className="text-zinc-200">{status.email ?? '—'}</dd>
            <dt>Plan</dt>
            <dd className="text-zinc-200">{status.subscriptionType ? planName(status.subscriptionType) : '—'}</dd>
            {status.orgName ? (
              <>
                <dt>Organización</dt>
                <dd className="text-zinc-200">{status.orgName}</dd>
              </>
            ) : null}
            <dt>Método</dt>
            <dd className="font-mono text-xs text-zinc-300">{status.authMethod ?? '—'}</dd>
            <dt>Claude Code</dt>
            <dd className="font-mono text-xs text-zinc-300">{status.version ?? '—'}</dd>
          </dl>
        ) : null}

        {status?.ignoredEnvVars.length ? (
          <p className="rounded-md bg-zinc-800/60 px-3 py-2 text-xs text-zinc-400">
            Tu entorno define <code className="text-zinc-200">{status.ignoredEnvVars.join(', ')}</code>. ADE la quita al
            lanzar Claude Code para que siempre use tu suscripción y no facture por API.
          </p>
        ) : null}

        {status && !status.installed ? (
          <div className="space-y-2 rounded-md bg-zinc-950 p-3 font-mono text-xs text-zinc-300">
            <p className="font-sans text-zinc-400">Instálalo en esta máquina y vuelve a comprobar:</p>
            <p>npm install -g @anthropic-ai/claude-code</p>
          </div>
        ) : null}

        {loginRun ? (
          <div className="space-y-2">
            <p className="text-xs text-zinc-400">
              Se abrirá tu navegador para autorizar con tu cuenta de Claude. Si no se abre, haz clic en el enlace de la
              terminal. Si te muestra un código, pégalo aquí (Ctrl+Shift+V) y pulsa Enter.
            </p>
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
          {status?.loggedIn ? (
            <Button onClick={() => void logout()} disabled={busy || loginActive}>
              <LogOut className="size-4" />
              Cerrar sesión
            </Button>
          ) : null}
          {status?.installed && !status.usesSubscription ? (
            <Button variant="primary" onClick={() => void login()} disabled={busy || loginActive}>
              <LogIn className="size-4" />
              {loginActive ? 'Esperando autorización…' : 'Iniciar sesión con mi suscripción'}
            </Button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

function planName(plan: string | null): string {
  if (!plan) return 'suscripción';
  const known: Record<string, string> = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' };
  return known[plan.toLowerCase()] ?? plan;
}

function headline(s: ClaudeAuthStatus): string {
  if (!s.installed) return 'Claude Code no está instalado en esta máquina';
  if (!s.loggedIn) return 'No has iniciado sesión en Claude Code';
  if (!s.usesSubscription) return 'Claude Code está usando facturación por API';
  return 'Conectado con tu suscripción';
}

function explanation(s: ClaudeAuthStatus): string {
  if (!s.installed) return 'ADE lanza el comando `claude`; sin él no se pueden crear tareas con Claude Code.';
  if (!s.loggedIn) return 'Inicia sesión con tu cuenta Pro o Max: los agentes usarán tu suscripción, sin API keys.';
  if (!s.usesSubscription) {
    return 'La sesión actual factura por uso (API key, Console o proveedor cloud). Inicia sesión con tu suscripción para cambiarlo.';
  }
  return 'Los agentes que lance ADE consumen de tu plan. No se usa ninguna API key.';
}
