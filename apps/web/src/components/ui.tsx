import { X } from 'lucide-react';
import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-500',
  secondary: 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700',
  danger: 'bg-rose-600/90 text-white hover:bg-rose-500',
  ghost: 'text-zinc-300 hover:bg-zinc-800',
};

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    />
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className={`w-full rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl ${wide ? 'max-w-lg' : 'max-w-md'}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h2 className="font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-zinc-400 hover:bg-zinc-800" title="Cerrar">
            <X className="size-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/** Estilo de campo sin tamaño, para combinar con anchos/paddings propios sin conflictos de Tailwind. */
export const fieldClass =
  'rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none';
export const inputClass = `${fieldClass} w-full py-2`;

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-zinc-300">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-zinc-500">{hint}</span> : null}
    </label>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? <p className="rounded-md bg-rose-950/60 px-3 py-2 text-sm text-rose-300">{children}</p> : null;
}
