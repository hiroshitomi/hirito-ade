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
    └── web/                  # @ade/web — React + Vite + Tailwind
        └── src/
            ├── api/client.ts         # cliente REST tipado con @ade/shared
            ├── hooks/usePolling.ts
            └── components/
                ├── Board.tsx         # Kanban: Te necesita / En curso / Para revisar / Sin cambios
                ├── TerminalGrid.tsx  # vista "Terminales": hasta 4 agentes en paralelo
                ├── NewTaskDialog.tsx # crea worktree + lanza agente
                ├── TaskDetail.tsx    # terminal, cambios, fusionar, descartar
                ├── AgentTerminal.tsx # xterm.js ← SSE, teclado → POST /input
                └── DiffViewer.tsx    # diff2html (carga diferida)
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
| GET | `/api/events` | SSE global: cambios de estado de los agentes (`working` / `waiting` / fin) |
| GET | `/api/claude/status` | Sesión de Claude Code: instalada, con sesión, ¿usa la suscripción? |
| POST | `/api/claude/login` · `/logout` | Login oficial (`claude auth login --claudeai`) en una terminal · cerrar sesión |
| GET | `/api/usage` | Último uso conocido de la suscripción: ventana de 5 h y semanal |
| POST | `/api/usage/report` | Lo llama la status line de los agentes (requiere `x-ade-token`) |
| GET | `/api/github/status` · POST `/login` · `/logout` | Cuenta de GitHub vía GitHub CLI (`gh auth login --web`) |
| GET | `/api/project` | Proyecto: rama, cambios, remoto de GitHub (sin credenciales) y ↑/↓ respecto a origin |

Seguridad: escucha solo en loopback, exige `Host` local y `Origin` en lista blanca
(`ADE_ALLOWED_ORIGINS`), y solo ejecuta comandos de presets — nunca uno enviado por HTTP.

## Desarrollo

```bash
npm install
ADE_REPO=/ruta/a/tu/repo npm run dev   # server (:4317) + dashboard en http://localhost:5173
npm test
npm run typecheck
```

`ADE_REPO` es el repositorio sobre el que trabajarán los agentes (no este proyecto).
Las columnas del tablero se derivan del estado real: agente esperando input → *Te necesita*;
agente trabajando → *En curso*; commits o cambios sin fusionar → *Para revisar*; nada → *Sin cambios*.

**"Te necesita"**: un agente pasa a `waiting` tras 2,5 s sin producir salida (las TUIs como
Claude Code redibujan un spinner mientras trabajan, así que el silencio indica que esperan
una confirmación o terminaron su turno). Se marca con borde ámbar parpadeante en el tablero
y en la vista *Terminales*, un contador en el título de la pestaña y, si las activas, una
notificación del navegador.

## Varios agentes en paralelo

- **Una rama por agente.** Cada tarea tiene su worktree y su rama; git no permite la misma
  rama en dos worktrees y ADE admite un solo agente activo por worktree. Dos agentes nunca
  escriben sobre los mismos ficheros en disco.
- **Estado del código por tarea.** Cada tarjeta, panel de terminal y detalle muestra lo que
  cambió ese agente respecto a su punto de partida (ficheros, +/−, commits) y si su base
  avanzó porque se fusionó otra tarea.
- **Solapes.** Si dos tareas tocan el mismo fichero, ambas lo avisan mientras trabajan: es
  el conflicto que aparecería al fusionar.
- **Subtareas.** Para repartir una feature entre varios agentes, crea una subtarea desde el
  detalle: parte de la rama de la tarea padre y, al aprobarla, se fusiona en esa rama (no
  en `main`). Solo ve lo que la tarea padre ya tiene **commiteado**.
- **Modo del agente** (Claude Code `--permission-mode`): *Manual* pregunta cada acción,
  *Auto* decide lo seguro y pregunta lo arriesgado, *Plan* solo propone un plan.

## Claude con tu suscripción

ADE no usa ninguna API: ejecuta el CLI oficial `claude`, que usa la sesión iniciada en la
máquina. Desde el indicador de la cabecera (*Conectar Claude* / *Claude · Max*) puedes
iniciar sesión con tu cuenta Pro/Max: ADE lanza `claude auth login --claudeai` en una
terminal integrada y nunca ve ni guarda credenciales.

Al ejecutar `claude`, ADE quita del entorno `ANTHROPIC_API_KEY` y `ANTHROPIC_AUTH_TOKEN`:
con ellas Claude Code facturaría por API en lugar de usar la suscripción.

**Uso de la suscripción.** Los agentes de Claude se lanzan con `--settings` añadiendo una
status line de ADE (`apps/server/bin/ade-statusline.mjs`). Claude Code le pasa los límites
del plan (`rate_limits.five_hour` y `seven_day`, solo Pro/Max) y el script los reenvía al
servidor, que los muestra en la barra superior y los guarda en `~/.ade/usage.json`. Aparecen
tras la primera respuesta de un agente; dentro de ADE, esta status line sustituye a la tuya.

## GitHub

La cuenta se conecta igual que la de Claude, con el CLI oficial (`gh auth login --web`) en una
terminal integrada. Instala GitHub CLI desde su
[repositorio oficial](https://github.com/cli/cli/blob/trunk/docs/install_linux.md): la versión
de Ubuntu suele ser antigua (ADE la soporta, pero leyendo la salida en texto).

Limitación conocida de node-pty: bajo carga, a veces se pierde la última salida de un proceso
que termina justo después de escribirla. No afecta a agentes interactivos de larga duración.
