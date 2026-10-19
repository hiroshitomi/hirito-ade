import { useCallback, useState } from 'react';

const supported = typeof window !== 'undefined' && 'Notification' in window;

/** Notificaciones del navegador. El permiso debe pedirse desde un clic del usuario. */
export function useNotifications() {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    supported ? Notification.permission : 'unsupported',
  );

  const request = useCallback(async () => {
    if (!supported) return;
    setPermission(await Notification.requestPermission());
  }, []);

  const notify = useCallback((title: string, body: string, tag: string, onClick?: () => void) => {
    // Si ya estás mirando el dashboard, el borde que parpadea es suficiente.
    if (!supported || Notification.permission !== 'granted' || document.hasFocus()) return;
    const n = new Notification(title, { body, tag });
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
  }, []);

  return { permission, request, notify };
}
