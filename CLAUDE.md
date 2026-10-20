# ADE — contexto para continuar el trabajo

ADE (Agent Development Environment): orquestador local para lanzar varios agentes de IA
en paralelo, cada uno en su `git worktree`, y supervisarlos desde un dashboard web.
Detalle técnico y API en `README.md`.

## Convenciones del proyecto

- Monorepo npm workspaces: `apps/server` (Fastify + TS), `apps/web` (React + Vite +
  Tailwind), `packages/shared` (solo tipos).
- Comentarios y textos de UI en **español**; identificadores en inglés.
- Capas: `routes` (HTTP, validación) → `services` (sin Fastify) → git / procesos.
- Los agentes se lanzan en PTY (`node-pty`) y solo desde presets de `apps/server/src/config.ts`
  (la API nunca recibe un comando arbitrario).
- Login de servicios (Claude, GitHub) siempre con su CLI oficial en una terminal integrada;
  ADE no maneja credenciales. A `claude` se le quitan `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`
  para que use la suscripción.
- Verificar antes de dar por hecho: `npm run typecheck`, `npm run build`,
  `cd apps/server && node --import tsx --test test/*.test.ts`, y probar la UI en navegador
  (Playwright) con agentes/CLIs simulados.
- Limitación conocida: node-pty a veces pierde la última salida de un proceso que termina
  justo después de escribirla (no es de ADE; ver comentario en `AgentProcessManager`).

## Estado actual (hecho)

**Proyecto desde la UI** (sin `ADE_REPO` obligatorio): bienvenida con "Examinar…" (diálogo
nativo: PowerShell FolderBrowserDialog en Windows, osascript en macOS, zenity/kdialog en
Linux), navegador de carpetas integrado, ruta pegada y recientes (`~/.ade/projects.json`,
se reabre el último). **Workspace**: carpeta con varios repos → un GitWorktreeService por
repo dentro de `ProjectService`; las tareas llevan `repo`, se crean eligiendo repo y los
solapes son por repo; detecta `.claude/skills` en la raíz. No se cambia de proyecto con
agentes en marcha.

Worktrees y fusión (merge/squash, por checkout o por ref, conflictos sin dejar nada a
medias) · agentes en PTY con SSE reanudable · tablero Kanban (Te necesita / En curso /
Para revisar / Sin cambios) · vista Terminales (hasta 4) · detección "esperando input"
(2,5 s sin salida) con borde parpadeante y notificaciones · cuenta de Claude (suscripción) ·
uso 5 h / semanal vía status line · cuenta de GitHub (`gh`) · barra de proyecto · modos
Manual/Auto/Plan (`--permission-mode`) · estado del código por tarea · avisos de solapes
entre tareas · subtareas (parten de la rama de otra y se fusionan en ella).

## Contexto de trabajo del usuario

- Ubuntu en el trabajo (shell fish), pero **las pruebas de ADE las hace en su PC con Windows**.
- Soporte Windows añadido sin probar en Windows real: node-pty 1.1.0 (binarios precompilados),
  parada sin señales, resolución de `.exe` por PATH/PATHEXT (`lib/command.ts`; un `.cmd` de npm
  da error claro), rutas de la status line con `/`, PowerShell como shell. Pendiente: feedback
  de la primera prueba en Windows.
- **6 repos** en total:
  - 4 principales: **front**, **back** y **2 microservicios**.
  - **testing**.
  - **documentation**: todos los docs, separados por **features**, **bugs** y **reglas de negocio**.
- Los 6 repos están bajo **una misma carpeta padre**, y `.claude/skills` está **en esa
  carpeta padre** (a la altura de los repos) → se abre en ADE como workspace.
- Suscripción de Claude (Max). Nada de API keys de Claude, Gemini ni GPT.

## Flujo de trabajo que ADE debe soportar (próximo gran bloque: "casos")

1. Llega un bug o mejora.
2. Una **skill** lo procesa y arma un documento.
3. Sesión de **preguntas y respuestas** hasta que no queden dudas.
4. Se completa el documento con todos los cambios por repo.
5. Se **ejecuta**: un agente por repo afectado, en paralelo.

### Diseño acordado (pendiente de implementar)

- Nueva unidad de trabajo: el **caso**, con fases
  `Entrada → Análisis → Preguntas → Ejecución → Revisión → Entrega`.
- **Análisis y preguntas con Opus** en modo Plan (`--model opus --permission-mode plan`),
  con acceso de lectura a los repos (`--add-dir`); ejecuta la skill y escribe el documento.
  Botón **"Aprobar plan"** como puerta antes de ejecutar.
- **Ejecución con Sonnet** (`--model sonnet`), un agente por repo afectado (no siempre los 4),
  misma rama en todos (`ade/caso-<id>`), lectura cruzada de los worktrees hermanos, y la
  regla "si algo no está en el documento, para y pregunta". Opción de relanzar un repo
  concreto con Opus.
- Revisión opcional con Opus comparando diffs contra el documento.
- Entrega: fusión en el orden de dependencias del documento, push y PRs enlazadas.
- El documento es el contrato: resumen, criterios de aceptación, contratos entre repos
  (endpoints, eventos entre microservicios, migraciones), una sección por repo
  (`## Repo: <nombre>`), orden de fusión.
- Motivo de Opus→Sonnet: con suscripción no se pagan tokens, pero Opus consume los
  límites de 5 h / semanal más rápido; el razonamiento caro se hace una sola vez.
- Requisito previo: **proyecto con varios repos** (`ade.config.json`) en lugar de un solo `ADE_REPO`.

### Decisiones derivadas de la información nueva

- El documento del caso debería guardarse en el repo **documentation** (features/, bugs/,
  reglas de negocio), no solo en `~/.ade`. Así queda versionado y el agente de análisis
  puede leer las reglas de negocio existentes como contexto.
- El repo **testing** probablemente sea otro repo afectado más en la ejecución (tests e2e
  del caso), con su propio agente.
- Las skills de `.claude/skills` se cargan solas si la sesión de análisis se lanza en la
  carpeta que las contiene (o se añade con `--add-dir`).

## Respuestas del usuario (cerradas)

1. `.claude/skills` está en la carpeta padre, a la altura de los repos.
2. Los 6 repos están bajo una misma carpeta padre.
3. Los bugs/mejoras llegan por ahora a mano, escritos como prompt (sin Jira/Issues).
4. Las preguntas y respuestas las contesta solo el usuario.
5. El documento de la skill es Markdown (`.md`).

## Siguiente paso previsto

Implementar los **casos** sobre el workspace: la sesión de análisis con Opus debe lanzarse
en la carpeta del workspace (donde están `.claude/skills`), con acceso a los repos
(`--add-dir`), y guardar el `.md` en el repo documentation. Ojo: hoy los worktrees viven en
`~/.ade/worktrees`, fuera del workspace, así que un agente lanzado en un worktree no ve las
skills de la carpeta padre; para la ejecución habrá que pasarle `--add-dir` o el contexto.

## Pendientes menores

- Paso de preparación por worktree (copiar `.env`, `npm install`) y conflicto de puertos
  al levantar varios stacks.
- Botones Subir (push) y Abrir PR tras fusionar.
- Subtareas: hoy solo ven lo commiteado por la tarea padre (opción: commitear antes).
- Modos para Codex (no verificados).
- Validar en el PC real: login de Claude/`gh`, campos de `claude auth status`, umbral de
  2,5 s de "esperando input", porcentajes de uso tras la primera respuesta.
