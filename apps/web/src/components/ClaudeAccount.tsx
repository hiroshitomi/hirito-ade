import type { ClaudeAuthStatus } from '@ade/shared';
import { api } from '../api/client';
import { ConnectionDialog, type ConnectionView, type Tone } from './ConnectionDialog';

/** Resumen corto para la barra de estado. */
export function claudeSummary(s: ClaudeAuthStatus): { tone: Tone; label: string } {
  if (!s.installed) return { tone: 'error', label: 'Claude Code no instalado' };
  if (!s.loggedIn) return { tone: 'warn', label: 'Conectar Claude' };
  if (!s.usesSubscription) return { tone: 'warn', label: 'Claude · API (pago por uso)' };
  return { tone: 'ok', label: `Claude · ${planName(s.subscriptionType)}` };
}

export function planName(plan: string | null): string {
  if (!plan) return 'suscripción';
  const known: Record<string, string> = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' };
  return known[plan.toLowerCase()] ?? plan;
}

interface DialogProps {
  status: ClaudeAuthStatus | null;
  onClose: () => void;
  onStatus: (s: ClaudeAuthStatus) => void;
}

/**
 * Conecta Claude Code con tu suscripción usando el login oficial del CLI
 * (`claude auth login --claudeai`): las credenciales quedan donde Claude Code las guarda siempre.
 */
export function ClaudeAccountDialog({ status, onClose, onStatus }: DialogProps) {
  return (
    <ConnectionDialog
      title="Cuenta de Claude"
      view={status ? claudeView(status) : null}
      loginLabel="Iniciar sesión con mi suscripción"
      loginHint="Se abrirá tu navegador para autorizar con tu cuenta de Claude. Si no se abre, haz clic en el enlace de la terminal. Si te muestra un código, pégalo aquí (Ctrl+Shift+V) y pulsa Enter."
      onRecheck={async () => onStatus(await api.claudeStatus())}
      onLogin={api.claudeLogin}
      onLogout={async () => onStatus(await api.claudeLogout())}
      onClose={onClose}
    />
  );
}

function claudeView(s: ClaudeAuthStatus): ConnectionView {
  const { tone } = claudeSummary(s);
  const mono = (v: string | null) => (v ? <span className="font-mono text-xs">{v}</span> : null);
  return {
    tone,
    headline: !s.installed
      ? 'Claude Code no está instalado en esta máquina'
      : !s.loggedIn
        ? 'No has iniciado sesión en Claude Code'
        : !s.usesSubscription
          ? 'Claude Code está usando facturación por API'
          : 'Conectado con tu suscripción',
    explanation: !s.installed
      ? 'ADE lanza el comando `claude`; sin él no se pueden crear tareas con Claude Code.'
      : !s.loggedIn
        ? 'Inicia sesión con tu cuenta Pro o Max: los agentes usarán tu suscripción, sin API keys.'
        : !s.usesSubscription
          ? 'La sesión actual factura por uso (API key, Console o proveedor cloud). Inicia sesión con tu suscripción para cambiarlo.'
          : 'Los agentes que lance ADE consumen de tu plan. No se usa ninguna API key.',
    rows: s.installed
      ? [
          ['Cuenta', s.email],
          ['Plan', s.subscriptionType ? planName(s.subscriptionType) : null],
          ...(s.orgName ? ([['Organización', s.orgName]] as [string, string][]) : []),
          ['Método', mono(s.authMethod)],
          ['Claude Code', mono(s.version)],
        ]
      : [],
    notes: (
      <>
        {s.ignoredEnvVars.length ? (
          <p className="rounded-md bg-zinc-800/60 px-3 py-2 text-xs text-zinc-400">
            Tu entorno define <code className="text-zinc-200">{s.ignoredEnvVars.join(', ')}</code>. ADE la quita al lanzar
            Claude Code para que siempre use tu suscripción y no facture por API.
          </p>
        ) : null}
        {!s.installed ? <InstallHint command="npm install -g @anthropic-ai/claude-code" /> : null}
      </>
    ),
    canLogin: s.installed && !s.usesSubscription,
    canLogout: s.loggedIn,
  };
}

export function InstallHint({ command, note, link }: { command: string; note?: string; link?: string }) {
  return (
    <div className="space-y-2 rounded-md bg-zinc-950 p-3 font-mono text-xs text-zinc-300">
      <p className="font-sans text-zinc-400">Instálalo en esta máquina y vuelve a comprobar:</p>
      <p>{command}</p>
      {note || link ? (
        <p className="font-sans text-zinc-500">
          {note}{' '}
          {link ? (
            <a href={link} target="_blank" rel="noreferrer" className="text-indigo-300 hover:underline">
              Ver instrucciones
            </a>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
