# Cómo agregar (o cambiar) un proveedor de mensajes

Guía para migrar de OpenWA a otro proveedor (ej. Meta Cloud API oficial) sin tocar el core del bot.

## Principio de diseño

El sistema está dividido en dos capas:

1. **Capa de proveedor** (touchable): validator VineJS + mapper + ruta del webhook. Es lo único que cambia entre proveedores.
2. **Capa del bot** (intocable): `InboundMessage` (shape canónico), debouncer, y flush handler. Cero conocimiento del proveedor.

```
payload del proveedor → validator → mapper → InboundMessage → debouncer → consolidado
                        └────── capa proveedor ──────┘   └────────── capa bot ──────────┘
```

## Pasos

### 1. Crear el validador del nuevo payload

En `app/validators/webhook.ts` agrega un validador por proveedor con los campos mínimos que necesita `InboundMessage`:

- id de mensaje, id de conversación/chat, teléfono del remitente, teléfono destino, texto/body, tipo de media, timestamp, y flag para descartar mensajes propios/grupos/status.

Cada proveedor es responsable de exponer el teléfono real del usuario si lo tiene explícito (como lo hace OpenWA con `senderPhone`).

### 2. Crear el mapper

En `app/mappers/` crea `meta_inbound_mapper.ts` (o el del proveedor). Debe exportar una función que reciba el payload ya validado (`Infer<typeof validator>`) y regrese un `InboundMessage`:

```ts
import type { Infer } from '@vinejs/vine/types'
import type { InboundMessage } from '#services/inbound_message'
import type { metaWebhookValidator } from '#validators/webhook'

export function metaToInbound(payload: Infer<typeof metaWebhookValidator>): InboundMessage {
  return {
    provider: 'meta',
    providerMessageId: payload.entry[0].changes[0].value.messages[0].id,
    // ...mapear los demás campos del payload de Meta a InboundMessage
  }
}
```

Reglas:

- Nada fuera de `app/mappers/` ni `app/validators/webhook.ts` conoce el proveedor.
- `occurredAt` es un `Date` en ms; `conversationId`/`providerMessageId` son strings del proveedor (se usan para dedupe, no cambies de formato entre mensajes).
- El mapper vive con lógica pura: no importa redis, ni DB, ni nada de infra.

### 3. Agregar la ruta del webhook

En `start/routes.ts`:

```ts
router.post('/api/webhooks/meta', [controllers.Webhook, 'store']).as('webhook.meta')
```

(Para Meta necesitarás además la ruta `GET` de verificación del webhook.)

### 4. Excluir la ruta de CSRF

En `config/shield.ts` agrega la ruta a `exceptRoutes`:

```ts
exceptRoutes: ['/api/webhooks/openwa', '/api/webhooks/meta']
```

### 5. Ajustar el controller

En `app/controllers/webhook_controller.ts`:

- Valida con el nuevo validator (`request.validateUsing(...)`).
- Ajusta los descartes de negocio (`fromMe`, `isGroup`, status, evento correcto) según cómo los exponga el proveedor.
- Llama al nuevo mapper y a `messageDebouncer.push(inbound)`. **Nada de esto cambia en el debouncer.**

### 6. Tests

Crea `tests/functional/meta_webhook.spec.ts` siguiendo `tests/functional/openwa_webhook.spec.ts`:

- 200 + encola en Redis (`redis.llen('debounce:buf:<telefono>') === 1`).
- 204 para mensajes que se descartan.
- Dos mensajes del mismo teléfono → buffer con 2 → después de la ventana, buffer en 0.

## Qué NO se toca

- `app/services/inbound_message.ts` (tipos canónicos)
- `app/services/message_debouncer_service.ts` (debouncing, Redis, Lua, poller)
- `start/debouncer.ts` (poller + flush handler)
- `config/redis.ts`

## Checklist final

- [ ] `pnpm typecheck` pasa
- [ ] `pnpm lint` pasa (usa `pnpm lint --fix`)
- [ ] `node ace test unit` y `node ace test functional` pasan con Redis local
- [ ] Detuviste Redis y cualquier dev server después de las pruebas
