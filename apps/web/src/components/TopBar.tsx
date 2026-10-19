import { ArrowDown, ArrowUp, Bot, ExternalLink, FolderGit2, GitBranch, Hand, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ClaudeAuthStatus, ClaudeUsage, GitHubAuthStatus, ProjectInfo, UsageWindow } from '@ade/shared';
import { claudeSummary } from './ClaudeAccount';
import { TONE_CLASS, TONE_ICON, type Tone } from './ConnectionDialog';
import { githubSummary } from './GitHubAccount';

/** Proyecto sobre el que trabajan los agentes: lo primero que hay que ver. */
export function ProjectSummary({ project }: { project: ProjectInfo | null }) {
  if (!project) return <div className="h-9" />;
  const gh = project.remote?.github;
  const up = project.upstream;
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <FolderGit2 className="size-4 shrink-0 text-indigo-300" />
        <h2 className="truncate text-base font-semibold" title={project.path}>
          {project.name}
        </h2>
        {gh ? (
          <a
            href={gh.url}
            target="_blank"
            rel="noreferrer"
            className="hidden items-center gap-1 rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 sm:flex"
            title="Abrir en GitHub"
          >
            {gh.owner}/{gh.repo}
            <ExternalLink className="size-3" />
          </a>
        ) : null}
      </div>
      <p className="flex flex-wrap items-center gap-x-2 font-mono text-xs text-zinc-500">
        <span className="flex items-center gap-1">
          <GitBranch className="size-3" />
          {project.branch ?? 'detached'}
        </span>
        <span className={project.changes ? 'text-amber-300' : ''}>
          {project.changes ? `${project.changes} cambio${project.changes === 1 ? '' : 's'} sin commitear` : 'limpio'}
        </span>
        {up && (up.ahead || up.behind) ? (
          <span className="flex items-center gap-1" title={`Respecto a ${up.name} (último fetch)`}>
            {up.ahead ? (
              <span className="flex items-center text-sky-300">
                <ArrowUp className="size-3" />
                {up.ahead} sin subir
              </span>
            ) : null}
            {up.behind ? (
              <span className="flex items-center text-amber-300">
                <ArrowDown className="size-3" />
                {up.behind} por bajar
              </span>
            ) : null}
          </span>
        ) : null}
        <span className="hidden truncate lg:inline" title={project.path}>
          {project.path}
        </span>
      </p>
    </div>
  );
}

interface StatusStripProps {
  claude: ClaudeAuthStatus | null;
  usage: ClaudeUsage | null;
  github: GitHubAuthStatus | null;
  working: number;
  waiting: number;
  onOpenClaude: () => void;
  onOpenGitHub: () => void;
}

/** Franja fija con conexiones, consumo de la suscripción y actividad de los agentes. */
export function StatusStrip(props: StatusStripProps) {
  const showUsage = props.claude?.usesSubscription ?? false;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-800 bg-zinc-900/50 px-4 py-2 text-xs">
      {props.claude ? (
        <Chip tone={claudeSummary(props.claude).tone} onClick={props.onOpenClaude} title={props.claude.email ?? 'Cuenta de Claude'}>
          {claudeSummary(props.claude).label}
        </Chip>
      ) : null}

      {showUsage ? <UsageMeters usage={props.usage} /> : null}

      <Divider />
      {props.github ? (
        <Chip tone={githubSummary(props.github).tone} onClick={props.onOpenGitHub} title="Cuenta de GitHub">
          {githubSummary(props.github).label}
        </Chip>
      ) : null}

      <div className="ml-auto flex items-center gap-3 text-zinc-400">
        <span className="flex items-center gap-1" title="Agentes trabajando">
          <Bot className={`size-3.5 ${props.working ? 'animate-pulse text-sky-400' : ''}`} />
          {props.working} trabajando
        </span>
        <span className={`flex items-center gap-1 ${props.waiting ? 'font-medium text-amber-300' : ''}`} title="Agentes esperando tu respuesta">
          <Hand className="size-3.5" />
          {props.waiting} te {props.waiting === 1 ? 'espera' : 'esperan'}
        </span>
      </div>
    </div>
  );
}

function UsageMeters({ usage }: { usage: ClaudeUsage | null }) {
  if (!usage?.updatedAt) {
    return (
      <span
        className="flex items-center gap-1 text-zinc-500"
        title="Claude Code informa de los límites tras la primera respuesta de un agente lanzado desde ADE"
      >
        <Info className="size-3.5" />
        Uso: aparece al trabajar el primer agente
      </span>
    );
  }
  const updated = `Actualizado ${relativeTime(usage.updatedAt)}`;
  return (
    <>
      <Meter label="5 h" window={usage.fiveHour} title={`Límite de la ventana de 5 horas. ${updated}`} />
      <Meter label="Semana" window={usage.sevenDay} title={`Límite semanal. ${updated}`} />
    </>
  );
}

function Meter({ label, window, title }: { label: string; window: UsageWindow | null; title: string }) {
  // Ventana reiniciada (o sin dato): 0 % hasta que llegue el siguiente reporte.
  const pct = window ? Math.round(window.usedPercentage) : 0;
  const color = pct >= 90 ? 'bg-rose-500' : pct >= 70 ? 'bg-amber-400' : 'bg-sky-400';
  const text = pct >= 90 ? 'text-rose-300' : pct >= 70 ? 'text-amber-300' : 'text-zinc-300';
  return (
    <span className="flex items-center gap-2" title={title}>
      <span className="text-zinc-500">{label}</span>
      <span
        className="h-1.5 w-20 overflow-hidden rounded-full bg-zinc-800"
        role="meter"
        aria-label={`Uso ${label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <span className={`block h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </span>
      <span className={`tabular-nums ${text}`}>{pct}%</span>
      <span className="text-zinc-500">{window ? `· ${resetLabel(window.resetsAt)}` : '· reiniciado'}</span>
    </span>
  );
}

function Chip(props: { tone: Tone; onClick: () => void; title: string; children: ReactNode }) {
  const Icon = TONE_ICON[props.tone];
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.title}
      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-medium ${TONE_CLASS[props.tone]}`}
    >
      <Icon className="size-3.5" />
      {props.children}
    </button>
  );
}

function Divider() {
  return <span className="hidden h-4 w-px bg-zinc-800 sm:block" />;
}

const timeFmt = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('es', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** "se reinicia 16:40" si es en menos de 24 h; si no, "se reinicia lun 09:00". */
function resetLabel(iso: string): string {
  const date = new Date(iso);
  const soon = date.getTime() - Date.now() < 24 * 3600 * 1000;
  return `se reinicia ${soon ? timeFmt.format(date) : dayFmt.format(date)}`;
}

function relativeTime(iso: string): string {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `hace ${h} h` : `hace ${Math.round(h / 24)} días`;
}
