import type { FastifyReply, FastifyRequest } from 'fastify';

export interface SseStream {
  send(event: string, data: unknown, id?: number): void;
  /** Cierra el stream (idempotente) y ejecuta los onClose registrados. */
  close(): void;
  onClose(fn: () => void): void;
  readonly closed: boolean;
}

/**
 * Toma el control de la respuesta y la convierte en un stream SSE con heartbeat.
 * Los datos van como JSON en una sola línea: la salida de un PTY contiene \n y \r
 * que romperían el framing de SSE.
 */
export function openSse(req: FastifyRequest, reply: FastifyReply, heartbeatMs: number): SseStream {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // proxies tipo nginx: no bufferizar
  });
  res.write('retry: 2000\n\n');

  // Comentarios periódicos: algunos proxies cortan conexiones inactivas.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
  const cleanups: (() => void)[] = [];
  let closed = false;

  const stream: SseStream = {
    send(event, data, id) {
      if (closed) return;
      res.write(`${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      for (const fn of cleanups) fn();
      res.end();
    },
    onClose(fn) {
      if (closed) fn();
      else cleanups.push(fn);
    },
    get closed() {
      return closed;
    },
  };
  req.raw.on('close', () => stream.close());
  return stream;
}
