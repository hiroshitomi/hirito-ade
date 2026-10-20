import type { GitHubAuthStatus, ProjectInfo } from '@ade/shared';
import { api } from '../api/client';
import { InstallHint } from './ClaudeAccount';
import { ConnectionDialog, type ConnectionView, type Tone } from './ConnectionDialog';

export function githubSummary(s: GitHubAuthStatus): { tone: Tone; label: string } {
  if (!s.installed) return { tone: 'error', label: 'GitHub CLI no instalado' };
  if (!s.loggedIn) return { tone: 'warn', label: s.login ? 'GitHub · sesión caducada' : 'Conectar GitHub' };
  return { tone: 'ok', label: `GitHub · @${s.login}` };
}

interface DialogProps {
  status: GitHubAuthStatus | null;
  project: ProjectInfo | null;
  onClose: () => void;
  onStatus: (s: GitHubAuthStatus) => void;
}

/**
 * Conecta GitHub con el login oficial de GitHub CLI (`gh auth login --web`). El token
 * queda en el almacén de `gh` y git lo usa para push/pull por HTTPS.
 */
export function GitHubAccountDialog({ status, project, onClose, onStatus }: DialogProps) {
  return (
    <ConnectionDialog
      title="Cuenta de GitHub"
      view={status ? githubView(status, project) : null}
      loginLabel="Iniciar sesión en GitHub"
      loginHint="Copia el código de un solo uso que aparece en la terminal, pulsa Enter para abrir github.com/login/device y pégalo allí. Si te pregunta si autenticar git con tus credenciales, responde que sí."
      onRecheck={async () => onStatus(await api.githubStatus())}
      onLogin={api.githubLogin}
      onLogout={async () => onStatus(await api.githubLogout())}
      onClose={onClose}
    />
  );
}

function githubView(s: GitHubAuthStatus, project: ProjectInfo | null): ConnectionView {
  const { tone } = githubSummary(s);
  const repos = project?.repos ?? [];
  const mono = (v: string | null) => (v ? <span className="font-mono text-xs">{v}</span> : null);
  return {
    tone,
    headline: !s.installed
      ? 'GitHub CLI (gh) no está instalado en esta máquina'
      : !s.loggedIn
        ? s.login
          ? `La sesión de @${s.login} no es válida`
          : 'No has iniciado sesión en GitHub'
        : `Conectado como @${s.login}`,
    explanation: !s.installed
      ? 'ADE usa GitHub CLI para la cuenta de GitHub: así push, pull y PRs usan tus credenciales.'
      : !s.loggedIn
        ? 'Inicia sesión para que ADE y los agentes puedan subir ramas y abrir pull requests con tu cuenta.'
        : 'Las ramas que fusiones se podrán subir con tu cuenta, y los agentes pueden usar `gh` para abrir PRs.',
    rows: s.installed
      ? [
          ['Cuenta', s.login ? `@${s.login}` : null],
          [
            repos.length > 1 ? 'Repositorios' : 'Repositorio',
            repos.length ? (
              <span className="flex flex-col gap-0.5 whitespace-normal">
                {repos.map((r) => (
                  <span key={r.name}>
                    {repos.length > 1 ? <span className="mr-2 text-zinc-500">{r.name}</span> : null}
                    {r.remote?.github ? (
                      <a href={r.remote.github.url} target="_blank" rel="noreferrer" className="text-indigo-300 hover:underline">
                        {r.remote.github.owner}/{r.remote.github.repo}
                      </a>
                    ) : (
                      <span className="text-zinc-400">{r.remote ? 'el remoto origin no es de GitHub' : 'sin remoto origin'}</span>
                    )}
                  </span>
                ))}
              </span>
            ) : null,
          ],
          ['Protocolo git', mono(s.gitProtocol)],
          ['Token', mono(s.tokenSource)],
          ['gh', mono(s.version)],
        ]
      : [],
    notes: (
      <>
        {s.error && s.installed ? (
          <p className="rounded-md bg-zinc-800/60 px-3 py-2 font-mono text-xs break-all text-zinc-400">{s.error}</p>
        ) : null}
        {!s.installed ? (
          <InstallHint
            command="sudo apt install gh"
            note="Mejor desde el repositorio oficial de GitHub CLI: la versión de Ubuntu suele ser antigua."
            link="https://github.com/cli/cli/blob/trunk/docs/install_linux.md"
          />
        ) : null}
      </>
    ),
    canLogin: s.installed && !s.loggedIn,
    canLogout: s.loggedIn,
  };
}
