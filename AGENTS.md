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
- **Flush handler**: se conecta en `start/debouncer.ts` (preload). Hoy solo loguea; ahí se conecta la lógica del bot.
- **Poller**: debe arrancarse una vez por proceso (preload en `adonisrc.ts`). Con varias instancias, el flush Lua garantiza que nadie reciba el mismo buffer dos veces.

## Llaves de Redis

| Key | Tipo | Descripción |
| --- | --- | --- |
| `debounce:buf:{phone}` | list | JSONs de `InboundMessage` en espera |
| `debounce:ready:{phone}` | string | epoch-ms en que toca flush |
| `debounce:seen:{provider}:{id}` | string | dedupe de reintentos, TTL 1h |

Los TTL de buf/ready son ventana + 60s (NO igual a la ventana: expirarían justo cuando el poller debe hacer flush).

## Endpoints

- `POST /api/webhooks/openwa` — webhook de OpenWA, sin CSRF (`config/shield.ts` → `exceptRoutes`), responde 200 si encola o 204 si descarta (`fromMe`, grupos, status, eventos no soportados).

## Estructura relevante

- `start/routes.ts` — rutas
- `start/debouncer.ts` — arranque del poller + flush handler
- `adonisrc.ts` — preloads y providers
- `config/redis.ts` — conexión Redis (usa `redis.connection('main')` en código)
- `tests/functional/openwa_webhook.spec.ts` — tests HTTP del webhook
- `tests/unit/message_debouncer_service.spec.ts` — tests del debouncer

## Convenciones

- Imports internos con alias `#...` (ej. `#services/inbound_message`, `#mappers/*`).
- Los tests limpian Redis con `group.each.setup` / `group.each.teardown` (NO `group.teardown`: corre una sola vez al final del grupo).
- El linter exige `import type` para imports usados solo como tipos.
