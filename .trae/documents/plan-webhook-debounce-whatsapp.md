# Plan: Webhook OpenWA + debouncer por `senderPhone` con Redis

Proyecto: AdonisJS v7, Postgres, `pnpm`. Monoproveedor (OpenWA), **un solo endpoint**, monoinstancia lógica. El proyecto sirve de **template**: si en el futuro se cambia de proveedor, lo único que se toca es `start/env.ts` (bandera `PROVIDER`), el payload-level  (arquetipo del mapper y su validador), y nada más de construir webhook, sistema de debounce ni la capa de Redis.

> Antes de tocar plantes/código: plantear el nivel inicial es plano, es una sola ruta, un worker. La brújula es: **payload raw → parse → InboundMessage (shape global) → debounce Redis → consolidate → emit**.

***

## 1 · Decisiones (confirmadas con el usuario)

| Decisión            | Valor                                                                                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proveedor           | `openwa` (único por ahora). Se modela la entrada como "proveedor actual" pero aislada detrás de un mapper                                                                                                                     |
| Endpoint            | `POST /api/webhooks/openwa` (uno solo). Serve template: en proyectos con otro proveedor la ruta tomaría el slug del proveedor                                                                                                 |
| Ventana             | 3000 ms desde el **último** mensaje (`WHATSAPP_WEBHOOK_DEBOUNCE_MS`, env, default 3000). Se re-arma en cada mensaje                                                                                                           |
| Clave de agrupación | `senderPhone`                                                                                                                                                                                                                 |
| Payload canónico    | `InboundMessage` (ver §3). Redis nunca ve payloads raw                                                                                                                                                                        |
| Dedupe              | `debounce:seen:{provider}:{providerMessageId}` (si un proveedor manda el mismo id dos veces se descarta)                                                                                                                      |
| Al expirar          | Emitir payload consolidado: `{ senderPhone, text (bodies unidos con \n), messageCount, first, last, messages[] (InboundMessages) }` al callback registrado en el servicio (log por ahora, `// TODO: conectar lógica del bot`) |
| Out (whatsapp)      | **fuera de alcance** por ahora: no se responde a WhatsApp en esta fase                                                                                                                                                        |

## 2 · Estado actual

- AdonisJS v7 (alpha) + `pnpm`, Postgres con Lucid, CSRF activo globalmente (`config/shield.ts`, `exceptRoutes: []`).
- No hay webhook ni lógica de mensajes existente; los modelos `Conversation/Message/Customer` están sin consumer y NO participan en esta fase.
- `@adonisjs/redis@11` compatible con Adonis v7 (verificado en npm), basado en ioredis.

## 3 · Payload canónico `InboundMessage`

Shape global que usa el debouncer el debouncer y Redis. Ninguna llave de Redis contiene raw ni nombres del proveedor.

```ts
interface InboundMessage {
  provider: 'openwa'                     // constante del proveedor de este proyecto
  providerMessageId: string              // data.id del gateway
  conversationId: string                 // chatId del proveedor
  senderPhone: string                    // 5219511576761
  recipientNumber: string                // 15403563171 (número de la línea/bot)
  body: string                           // Body "" si no content-type (ya combinado)
  mediaType: string                      // text | image | audio | ...
  occurredAt: Date                       // timestamp normalizado
  contactName: string | null             // pushName
  raw: unknown                           // payload original completo (debug)
}
```

El consolidado que recibe el callback del flush:

```ts
{
  senderPhone: string,
  text: string,                          // bodies unidos con '\n'
  messageCount: number,
  firstAt: Date, lastAt: Date,
  messages: InboundMessage[]
}
```

## 4 · Diseño Redis (debounce real)

| Llave                                  | Tipo                                 | Uso                                                                 | TTL                                    |
| -------------------------------------- | ------------------------------------ | ------------------------------------------------------------------- | -------------------------------------- |
| `debounce:buf:{phone}`                 | List (jsonb InboundMessage por item) | Buffer de mensajes del remitente                                    | Re-armada a X segundos en cada `RPUSH` |
| `debounce:ready:{phone}`               | String (epoch-ms listo para flush)   | Cita de expiración = `now + window`, actualizada en cada mensaje    | Re-armada a X segundos junto al buffer |
| `debounce:seen:{provider}:{messageId}` | String (1)                           | Dedupe de mensajes idénticos del proveedor (reintentos del gateway) | 1 hora                                 |

- **Al llegar mensaje**: `RPUSH` + `SET ready` + `EXPIRE` ambas (MULTI) + `SET seen ... EX 3600`.
- **Poller de flush** (en `app/services/message_debouncer_service.ts`, `setInterval(500ms)` arrancado por preload): `SCAN debounce:ready:*`, y para cada teléfono con `readyAt <= now` ejecuta script **Lua atómico**: `LRANGE` + `DEL` de ambas llaves y devuelve el arreglo; se garantiza que aunque hayan varias instancias del app, nadie más tocará el grupo.
- **Se elige polling** en lugar de keyspace notifications: las notificaciones de expiración solo se emiten cuando la llave se elimina por TTL (best-effort), no cuando se re-arma el `SET`, y además disparan sobre "venció desde el primero", no desde el último.

## 5 · Cambios por archivo

1. **Dependencias** — `pnpm add @adonisjs/redis ioredis`.
2. **`node ace configure @adonisjs/redis`** — crea `config/redis.ts`, provider en `adonisrc.ts`, preload de servicio y vars `REDIS_CONNECTION/REDIS_HOST/REDIS_PORT/REDIS_PASSWORD` (Opcionalmente local docker).
3. **`app/services/inbound_message.ts`** (nuevo) — type `InboundMessage` + type `ConsolidatedInbound` (el payload consolidado).
4. **`app/validators/openwa_webhook.ts`** (nuevo) — validador VineJS para el payload de OpenWA. Campos esenciales requeridos: `event`, `data.id`, `data.from`, `data.to`, `data.chatId`, `data.body` (nullable), `data.type`, `data.timestamp` (número), `data.fromMe`, `data.isGroup`, `data.senderPhone`. Lo demás `optional()` para tolerar variaciones.
5. **`app/mappers/openwa_inbound_mapper.ts`** (nuevo) — el **único archivo que conoce a OpenWA**: recibe el payload validado y devuelve `InboundMessage`. Cambiar de proveedor a futuro = crear `xxx_inbound_mapper.ts` + su validador + su slug de ruta, nada más.
6. **`app/services/message_debouncer_service.ts`** (nuevo, core)
   - `push(msg: InboundMessage)`: dedupe (`debounce:seen:…`), `RPUSH`, `SET ready`, `EXPIRE`. Todo con `redis` service de `@adonisjs/redis`; abstrae lógica de negocio, no sabe nada del proveedor.
   - Poller con Lua atómico; construye `ConsolidatedInbound` y llama al callback.
   - Fallback: si Redis falla, Map en memoria en el mismo proceso (log warn) para no perder los webhooks que van llegando.
   - Singleton con callback registrable: `messageDebouncer.setFlushHandler(fn)`.
7. **`app/controllers/webhook_controller.ts`** (nuevo)
   - `store({ request, response })`: valida → descarta (`204`) eventos fuera de alcance (`fromMe`, `isGroup`, `isStatusBroadcast`) → llama `mapper` → `messageDebouncer.push(inbound)` → `200 { acknowledged: true }`.
8. **`start/routes.ts`** — `router.post('/api/webhooks/openwa', [controllers.Webhook, 'store']).as('webhook.openwa')`.
9. **`config/shield.ts`** — `csrf.exceptRoutes: ['/api/webhooks/openwa']` (formato string\[], confirmado en types del shield).
10. **`start/debouncer.ts`** (nuevo, preload) — arranca el poller al iniciar app. Registrarlo en `adonisrc.ts` → `preloads`.
11. **`start/env.ts`** + `.env`, `.env.example`, `.env.test` — vars Redis (las que genera el `configure`) + `WHATSAPP_WEBHOOK_DEBOUNCE_MS` (test usa 250 ms para no esperart).
12. **Tests**
    - `tests/functional/openwa_webhook.spec.ts` — POST válido → 200; fuera de alcance → 204; dos POST consecutivos del mismo teléfono → 1 consolidado (tras la ventana).
    - `tests/unit/message_debouncer_service.spec.ts` — ventana re-armable, dedupe, formato del consolidado (usando Redis real de la env de test o interfaz mock).

## 6 · Nota de setup Redis local

- Para probar local: dejear pendiente levantarlo

## 7 · Verificación

- `pnpm test` (unit + functional). Detener el servidor dev después de las pruebas.
- `pnpm typecheck`.
- Manual: Redis up + `pnpm dev` + doble `curl` del mismo teléfono → en logs UN consolidado con los bodies unidos por `\n`. Detener server al terminar.

