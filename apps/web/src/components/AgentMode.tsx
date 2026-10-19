import { ClipboardList, ShieldCheck, Zap } from 'lucide-react';
import type { AgentMode } from '@ade/shared';

export const MODE_INFO: Record<AgentMode, { label: string; hint: string; Icon: typeof Zap; className: string }> = {
  manual: {
    label: 'Manual',
    hint: 'Pide confirmación antes de cada edición o comando.',
    Icon: ShieldCheck,
    className: 'text-zinc-300',
  },
  auto: {
    label: 'Auto',
    hint: 'Hace solo lo que considera seguro y te pregunta lo arriesgado.',
    Icon: Zap,
    className: 'text-emerald-300',
  },
  plan: {
    label: 'Plan',
    hint: 'Solo investiga y propone un plan; no toca ficheros hasta que lo apruebes.',
    Icon: ClipboardList,
    className: 'text-violet-300',
  },
};

const STORAGE_KEY = 'ade.agentMode';

/** Último modo elegido: es una preferencia personal, se recuerda entre tareas. */
export function loadPreferredMode(available: AgentMode[]): AgentMode | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as AgentMode | null;
    if (saved && available.includes(saved)) return saved;
  } catch {
    // Sin almacenamiento: se usa el predeterminado del agente.
  }
  return available[0] ?? null;
}

function savePreferredMode(mode: AgentMode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Ignorado: solo es una preferencia.
  }
}

/** Selector segmentado Manual / Auto / Plan. */
export function ModePicker(props: {
  modes: AgentMode[];
  value: AgentMode | null;
  onChange: (mode: AgentMode) => void;
  compact?: boolean;
}) {
  if (props.modes.length === 0) return null;
  const current = props.value ? MODE_INFO[props.value] : null;
  return (
    <div className={props.compact ? '' : 'space-y-1.5'}>
      <div className="inline-flex rounded-md border border-zinc-700 bg-zinc-950 p-0.5" role="radiogroup" aria-label="Modo del agente">
        {props.modes.map((m) => {
          const info = MODE_INFO[m];
          const active = props.value === m;
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={active}
              title={info.hint}
              onClick={() => {
                savePreferredMode(m);
                props.onChange(m);
              }}
              className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-sm ${
                active ? `bg-zinc-800 ${info.className}` : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <info.Icon className="size-3.5" />
              {info.label}
            </button>
          );
        })}
      </div>
      {!props.compact && current ? <p className="text-xs text-zinc-500">{current.hint}</p> : null}
    </div>
  );
}

/** Etiqueta del modo con el que arrancó un agente. */
export function ModeBadge({ mode }: { mode: AgentMode | null }) {
  if (!mode) return null;
  const info = MODE_INFO[mode];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-xs ${info.className}`}
      title={`Modo ${info.label} al arrancar: ${info.hint} (el agente puede cambiarlo después, p.ej. con Shift+Tab)`}
    >
      <info.Icon className="size-3" />
      {info.label}
    </span>
  );
}
