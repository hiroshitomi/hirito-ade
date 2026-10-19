# ADE — Agent Development Environment

Orquestador local para ejecutar varios agentes de IA en paralelo sobre el mismo repo,
cada uno aislado en su propio `git worktree` + rama.

## Estructura

```
ade/
├── package.json              # npm workspaces
├── tsconfig.base.json
├── packages/
│   └── shared/               # @ade/shared — contratos (DTOs) server <-> web, solo tipos
│       └── src/index.ts
└── apps/
    ├── server/               # @ade/server — Fastify + TypeScript
    │   ├── src/
    │   │   ├── index.ts              # bootstrap Fastify, error handler
    │   │   ├── lib/
    │   │   │   ├── errors.ts         # errores de dominio con statusCode HTTP
    │   │   │   └── mutex.ts          # serializa escrituras sobre el repo
    │   │   ├── services/
    │   │   │   ├── GitWorktreeService.ts   # Fase 1
    │   │   │   └── AgentProcessManager.ts  # Fase 2 (spawn/pty + buffer de logs)
    │   │   └── routes/
    │   │       ├── worktrees.ts      # Fase 1: REST
    │   │       └── agents.ts         # Fase 2: SSE /api/agents/:id/stream
    │   └── test/
    └── web/                  # @ade/web — React + Vite + Tailwind (Fase 3)
        └── src/
            ├── api/          # cliente REST + EventSource tipado con @ade/shared
            ├── components/   # TaskCard, Terminal (xterm), DiffViewer
            └── views/        # Dashboard, TaskDetail
```

Capas: `routes` (HTTP, validación) → `services` (lógica de dominio, sin Fastify) → git / procesos.
Los servicios no conocen HTTP; las rutas no conocen git.

## API (127.0.0.1:4317)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/worktrees/create` | `{ name, baseRef?, branch? }` → crea worktree + rama `ade/<id>` |
| GET | `/api/worktrees` | Lista con estado (dirty, ahead/behind, agentRunning) |
| GET | `/api/worktrees/:id` · `/:id/diff` | Detalle · diff completo vs. base |
| DELETE | `/api/worktrees/:id?force&keepBranch` | Detiene agentes y elimina worktree + rama |
| POST | `/api/worktrees/merge` | `{ id, strategy?, targetBranch?, message? }` (409 si hay agente activo o conflictos) |
| GET | `/api/agents/presets` | Agentes lanzables (definidos en `src/config.ts`) |
| POST | `/api/agents` | `{ worktreeId, preset, prompt?, cols?, rows? }` → lanza en PTY |
| GET | `/api/agents/:id/stream` | SSE `output`/`exit`, reanudable con `Last-Event-ID` |
| POST | `/api/agents/:id/input` · `/resize` · `/stop` | Teclado de xterm · tamaño · SIGTERM→SIGKILL |

Seguridad: escucha solo en loopback, exige `Host` local y `Origin` en lista blanca
(`ADE_ALLOWED_ORIGINS`), y solo ejecuta comandos de presets — nunca uno enviado por HTTP.

## Desarrollo

```bash
npm install
ADE_REPO=/ruta/a/tu/repo npm run dev:server   # http://127.0.0.1:4317/api/health
npm test
npm run typecheck
```
