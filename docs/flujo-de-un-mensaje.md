# Flujo de un mensaje entrante

Qué pasa cada vez que un customer manda un mensaje de WhatsApp, separado por etapas, y qué archivo hace qué.

> Nota: el repo solo soporta OpenWA como proveedor por ahora, pero la arquitectura está pensada para poder cambiar de proveedor sin tocar el core (ver `docs/como-agregar-un-proveedor.md`).

## Diagrama del flujo

Todo arranca en un solo `POST /api/webhooks/openwa`.

```
                    ┌─────────────────────────────────────────────┐
   1. HTTP          │  Cliente de WhatsApp → OpenWA gateway       │
                    └──────────────────┬──────────────────────────┘
                                       │ POST /api/webhooks/openwa
                                       ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 2. RECEPCIÓN (webhook)                                                 │
│    app/controllers/webhook_controller.ts                               │
│    ├─ valida payload              → app/validators/webhook.ts          │
│    ├─ descarta basura (204): fromMe / grupos / status / otro event      │
│    ├─ traduce payload a shape global:                                  │
│    │     app/mappers/openwa_inbound_mapper.ts → InboundMessage         │
│    ├─ messageDebouncer.push(inbound)     ← encola en Redis             │
│    └─ inactivityTracker.recordActivity(phone) ← reinicia escalera      │
│                                                                        │
│    → responde 200 inmediatamente (el trabajo real va después)          │
└──────────────────────────┬─────────────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 3. DEBOUNCE (agrupa ráfagas)                                           │
│    app/services/message_debouncer_service.ts                           │
│    ├─ push(): Redis                                  ┌──────────────┐  │
│    │    debounce:buf:{phone}      list de JSONs      │  Redis       │  │
│    │    debounce:ready:{phone}    epoch-ms del flush │              │  │
│    │    debounce:seen:*           dedupe de reintentos│              │  │
│    ├─ ventana 3000ms (env WHATSAPP_WEBHOOK_DEBOUNCE_MS)└──────────────┘  │
│    ├─ startPoller(): SCAN cada 500ms, arranca en start/debouncer.ts    │
│    ├─ flush atómico con script Lua (nadie recibe el mismo buffer 2x)   │
│    └─ emite ConsolidatedInbound { phone, text, messageCount... }       │
└──────────────────────────┬─────────────────────────────────────────────┘
                           │ flushHandler (seteado en start/debouncer.ts)
                           ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 4. ORQUESTADOR = un "turno"                     (por persona, en serie)│
│    app/services/agent_orchestrator_service.ts                          │
│    ├─ lock: agent:lock:{phone} TTL 120s                                │
│    │     garantiza que el turno anterior guardó su reply primero       │
│    ├─ Customer.firstOrCreate    (id determinista por teléfono)         │
│    ├─ Conversation.firstOrCreate                                       │
│    ├─ Message.create({subject:'user', text consolidado})               │
│    └─ carga historial completo   → app/models/message.ts               │
└──────────────────────────┬─────────────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 5. ROUTER con Jev (TypeSafe)                                           │
│    app/services/agent_intent_service.ts                                │
│    ├─ state = mensaje + último mensaje del bot + últimos 6 del historial│
│    └─ intent: 'appointment' | 'inquiry' | 'other'   (fallback: 'other')│
└──────────────────────────┬─────────────────────────────────────────────┘
                           │ según el intent
        ┌──────────────────┼─────────────────────┐
        ▼                  ▼                     ▼
┌────────────────┐ ┌──────────────────┐ ┌────────────────────┐
│ appointment    │ │ inquiry          │ │ other (por defecto)│
│ agent_appoint- │ │ agent_inquiry_   │ │ agent_greeting_    │
│ ment_service   │ │ service          │ │ service            │
│ (Vercel AI)    │ │ (Vercel AI)      │ │ (Vercel AI)        │
└───────┬────────┘ └────────┬─────────┘ └─────────┬──────────┘
        └───────────────────┴─────────────────────┘
                           │ reply (string)
                           ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 6. SALIDA                                                              │
│    Message.create({subject:'assistant', text: reply}) ← entra al       │
│       historial en el próximo turno                                    │
│    TODO: envío real por WhatsApp (hoy solo guarda el reply)             │
│    libera el lock; el turno siguiente puede correr                      │
└────────────────────────────────────────────────────────────────────────┘
```

## En una frase

El usuario manda una ráfaga de mensajes → el webhook valida y normaliza a `InboundMessage` → Redis agrupa los mensajes con una ventana de silencio de 3 s → el poller hace el flush y arranca un turno en el orquestador (lock serial por teléfono) → se guarda el mensaje del usuario en Postgres → Jev decide el intent → un agente genera el reply → se guarda como mensaje `assistant` (falta el envío real por WhatsApp).

## Mapa de archivos

| Archivo | Por qué existe |
| --- | --- |
| `app/controllers/webhook_controller.ts` | Puerta de entrada HTTP. Filtra basura (fromMe, grupos) y encola en Redis. |
| `app/validators/webhook.ts` | Valida el payload con VineJS antes de que el mapper lo toque. |
| `app/mappers/openwa_inbound_mapper.ts` | Único archivo que sabe cómo hablan los proveedores. Cambiar de proveedor = nuevo mapper + validador. |
| `app/services/inbound_message.ts` | Define `InboundMessage` y `ConsolidatedInbound`: el "contrato" de datos entre etapas. |
| `app/services/message_debouncer_service.ts` | Agrupa ráfagas por teléfono en Redis con script Lua atómico para que dos instancias nunca reciban el mismo buffer. |
| `app/services/agent_ids.ts` | Para no consultar DB dos veces: mismo teléfono → mismos UUIDs deterministas de Customer y Conversation. |
| `app/services/agent_orchestrator_service.ts` | Corre el "turno": lock serial por teléfono, guarda mensaje, arma historial, elige agente, guarda respuesta. |
| `app/services/agent_intent_service.ts` | El router. Decide con Jev (TypeSafe) qué agente corre según el intent del turno. |
| `app/services/agent_appointment_service.ts` | Agente de citas (Vercel AI SDK), se corre cuando el intent es `appointment`. |
| `app/services/agent_inquiry_service.ts` | Agente de consultas (Vercel AI SDK), se corre cuando el intent es `inquiry`. |
| `app/services/agent_greeting_service.ts` | Agente por defecto (Vercel AI SDK), se corre cuando el intent es `other`. |
| `app/services/inactivity_tracker_service.ts` | No es del flujo por mensaje: escalera de lapsos (30 min → 72 h) de silencio para reenganchar con el cliente. |
| `start/debouncer.ts` | Arranca los pollers (debouncer + inactivity) y conecta el flushHandler → orquestador. |
| `start/routes.ts` | Expone `POST /api/webhooks/openwa`. |

## Llaves de Redis involucradas

| Key | Tipo | Para qué |
| --- | --- | --- |
| `debounce:buf:{phone}` | list | JSONs de `InboundMessage` en espera de la ventana |
| `debounce:ready:{phone}` | string | epoch-ms en que toca flush |
| `debounce:seen:{provider}:{id}` | string | dedupe de reintentos del proveedor, TTL 1h |
| `agent:lock:{phone}` | string | token UUID del dueño del turno en curso, TTL 120s |
| `inactivity:{phone}` | hash | `lastActivityAt` + `level` de la escalera de inactividad |

## Detalles que suelen sorprender al leer el código

- **El webhook responde rápido (HTTP 200/204)** y todo lo demás va en background con Redis — nunca espera al LLM.
- **El debounce no es por mensaje, es por teléfono**: si el usuario manda 5 mensajes seguidos, se consolidan como un solo turno con el texto unido por saltos de línea.
- El **lock serial** `agent:lock:{phone}` existe porque, si no, un turno arrancaría sin ver en su historial la respuesta del turno anterior que todavía no se guarda.
- `agent_ids.ts` es puro determinismo: nunca haces `Customer.findBy('phone', ...)` — el UUID se calcula desde el teléfono.
- El último paso (enviar `reply` por WhatsApp) es **TODO** — si pruebas en local, el bot "responde" pero solo guardando el dato en Postgres.
