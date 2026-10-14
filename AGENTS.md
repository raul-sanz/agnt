# AGENTS.md

Guía para agentes de IA (y humanos) que trabajan en este proyecto.

## Qué es este proyecto

Bot de WhatsApp construido con **AdonisJS v7 (alpha) + Inertia/Vue + Postgres (Lucid) + Redis**, usando **OpenWA** como proveedor de WhatsApp.

Su rol principal es recibir webhooks de mensajes de WhatsApp, agrupar en ráfaga por número de teléfono (debouncing) y procesar el consolidado después de X segundos de silencio del usuario. Está pensado como **template/base** para crear más proyectos similares: la estructura soporta cambiar de proveedor sin tocar el core.

## Stack y reglas del proyecto

- **Gestor de paquetes**: siempre `pnpm` (nunca npm ni yarn).
- **No dejar servicios corriendo** después de pruebas/sesión: apagar Redis (`brew services stop redis` / `kill` del `redis-server`) y cualquier dev server.
- Typecheck: `pnpm typecheck` (tsc + vue-tsc). Debe pasar antes de terminar cualquier cambio.
- Lint: `pnpm lint` (eslint + prettier). Usar `pnpm lint --fix`.
- Tests: `node ace test unit` y `node ace test functional` (necesitan Redis local corriendo para el debouncer).

## Arquitectura del flujo de mensajes

```
Proveedor (OpenWA) → webhook endpoint
  → validator (VineJS)        app/validators/webhook.ts
  → mapper (provider → shape global)   app/mappers/
  → InboundMessage (shape canónico)    app/services/inbound_message.ts
  → debouncer (Redis + Lua + poller)   app/services/message_debouncer_service.ts
  → flush handler (arranca el bot/lógica)   start/debouncer.ts
```

Conceptos clave:

- **`InboundMessage`** (`app/services/inbound_message.ts`): shape canónico e independiente del proveedor. Es lo único que el debouncer entiende. Campos: `provider`, `providerMessageId`, `conversationId`, `senderPhone`, `recipientNumber`, `body`, `mediaType`, `occurredAt`, `contactName`, `raw`.
- **`ConsolidatedInbound`** (mismo archivo): payload emitido tras el debounce; `{ senderPhone, text, messageCount, firstAt, lastAt, messages }`.
- **Mapper** (`app/mappers/`): el ÚNICO lugar que conoce la estructura del proveedor. Cambiar de proveedor = nuevo validator + nuevo mapper (ver `docs/como-agregar-un-proveedor.md`).
- **Debouncer** (`app/services/message_debouncer_service.ts`): agrupa por `senderPhone` con ventana re-armable (default 3000ms, env `WHATSAPP_WEBHOOK_DEBOUNCE_MS`). Guarda en Redis (`debounce:buf:*`, `debounce:ready:*`, `debounce:seen:*`), usa script Lua atómico para flush idempotente, poller con SCAN cada 500ms (`startPoller`) y dedupe de reintentos por `providerMessageId` (TTL 1h). Fallback a Map en memoria si Redis cae.
- **Flush handler**: se conecta en `start/debouncer.ts` (preload): delega al `agentOrchestrator.handle()` (`app/services/agent_orchestrator_service.ts`).
- **Poller**: debe arrancarse una vez por proceso (preload en `adonisrc.ts`). Con varias instancias, el flush Lua garantiza que nadie reciba el mismo buffer dos veces.
- **Tracker de inactividad** (`app/services/inactivity_tracker_service.ts`): tras cada mensaje del usuario registra actividad en Redis y dispara una **escalera de lapsos** fijos de inactividad: `[30min, 1h, 3h, 12h, 24h, 72h]`. Cada mensaje del usuario resetea al nivel 0; cuando un lapso se cumple, el poller lo dispara y avanza al siguiente nivel aunque el usuario no escriba (al agotar la escalera, borra la llave). Lapso 0 configurable con env `INACTIVITY_FIRST_LAPSE_MS` para pruebas (actualmente 120000 = 2 min). El poller corre cada 5s y la decisión de disparo está en un Lua atómico (nunca dispara dos veces el mismo nivel entre instancias). Fallback a Map en memoria si Redis cae. La acción a ejecutar se registra en `start/debouncer.ts` con `inactivityTracker.setLapseHandler()` (placeholder: log). Los tests pueden sobreponer la escalera con `inactivityTracker.setLapsesForTesting(...)`.

## Orquestador del agent (por turno)

Cada flush del debouncer = un **turno** que corre en `agent_orchestrator_service.ts`:

1. Crea el mensaje del usuario en la DB y consulta el historial de la conversación.
2. **Router con Jev** (TypeSafe, `@typesafe-ai/sdk`) en `app/services/agent_intent_service.ts`: clasifica el turno en 3 intents (`appointment` | `inquiry` | `other`) con fallback a `other` si Jev falla. El state que se le pasa incluye `mensaje_anterior_bot` + `historial_reciente` (ventana de 6) para que entienda respuestas cortas ("sí", "ok", "Link").
3. Según el intent, corre el agente correspondiente (`agent_appointment_service.ts` / `agent_inquiry_service.ts` / `runGreetingAgent`, todos Vercel AI SDK) con el historial completo.
4. Guarda la respuesta como mensaje `assistant` (en el próximo turno entra al historial). El envío real por WhatsApp aún es TODO.

**Lock serial por teléfono** (`agent:lock:{phone}`, TTL 120s): los turnos del mismo teléfono corren en serie. Sin esto, el flush de una ráfaga nueva puede disparar un turno mientras el anterior sigue generando su reply con el LLM → el historial consultado no tendría la respuesta del turno previo (`mensaje_anterior_bot` desactualizado/null). El lock usa token UUID + release vía Lua (nunca suelta el lock de otro dueño). Degradación: si Redis cae o la espera de 30s expira, procesa sin exclusión (warn).

**Pendiente V2 — abort por teléfono**: cuando se implemente el envío real por WhatsApp, añadir `Map<phone, AbortController>` en el orquestador: si un turno nuevo llega y el lock está tomado, aborta al turno en vuelo (solo si está en fase de generación del LLM; si el reply ya se generó, dejarlo terminar) para responder una sola vez al consolidado real y no gastar tokens en replies obsoletos. El abort NO reemplaza al lock (abandonar la serialización permitiría volver al historial inconsistente); es un añadido al caso de espera. El mensaje del usuario del turno abortado ya está en la DB, así que el turno siguiente lo ve en el historial sin fusionar nada a mano.

## Llaves de Redis

| Key | Tipo | Descripción |
| --- | --- | --- |
| `debounce:buf:{phone}` | list | JSONs de `InboundMessage` en espera |
| `debounce:ready:{phone}` | string | epoch-ms en que toca flush |
| `debounce:seen:{provider}:{id}` | string | dedupe de reintentos, TTL 1h |
| `agent:lock:{phone}` | string | token UUID del dueño del turno en curso, TTL 120s |
| `inactivity:{phone}` | hash | `lastActivityAt` (epoch-ms) + `level` (índice del lapso en curso) |

Los TTL de buf/ready son ventana + 60s (NO igual a la ventana: expirarían justo cuando el poller debe hacer flush).

## Endpoints

- `POST /api/webhooks/openwa` — webhook de OpenWA, sin CSRF (`config/shield.ts` → `exceptRoutes`), responde 200 si encola o 204 si descarta (`fromMe`, grupos, status, eventos no soportados).

## Estructura relevante

- `start/routes.ts` — rutas
- `start/debouncer.ts` — arranque del poller + flush handler
- `app/services/agent_orchestrator_service.ts` — turno del agent (lock serial + routing + agente)
- `app/services/agent_intent_service.ts` — router Jev/TypeSafe (intents appointment/inquiry/other)
- `app/services/agent_appointment_service.ts`, `app/services/agent_inquiry_service.ts` — agentes conversacionales (Vercel AI SDK)
- `app/services/agent_ids.ts` — IDs deterministas (`customerIdFromPhone` / `conversationIdFromPhone`): mismo teléfono → mismos UUIDs sin consultar la DB. Cualquier módulo los usa para resolver customer/conversación por teléfono.
- `app/services/inactivity_tracker_service.ts` — escalera de lapsos de inactividad por teléfono
- `adonisrc.ts` — preloads y providers
- `config/redis.ts` — conexión Redis (usa `redis.connection('main')` en código)
- `tests/functional/openwa_webhook.spec.ts` — tests HTTP del webhook
- `tests/unit/message_debouncer_service.spec.ts` — tests del debouncer
- `tests/unit/inactivity_tracker_service.spec.ts` — tests del tracker de inactividad (necesitan `node ace test unit --timeout 15000`: el test del debouncer duerme ~6s por su ventana, el timeout default de la suite unit es 2s)

## Convenciones

- Imports internos con alias `#...` (ej. `#services/inbound_message`, `#mappers/*`).
- Los tests limpian Redis con `group.each.setup` / `group.each.teardown` (NO `group.teardown`: corre una sola vez al final del grupo).
- El linter exige `import type` para imports usados solo como tipos.
