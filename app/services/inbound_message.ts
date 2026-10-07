/**
 * Shape global (canónico) de un mensaje entrante.
 *
 * Ningún proveedor (OpenWA, Meta Cloud API, etc.) debe llegar a Redis
 * con su payload original: primero se parsea a `InboundMessage`.
 *
 * Cambiar de proveedor = crear un nuevo mapper + validador, nada más.
 */
export interface InboundMessage {
  provider: 'openwa'
  /** Id único del mensaje en el proveedor (para dedupe) */
  providerMessageId: string
  /** Id de la conversación según el proveedor (chatId) */
  conversationId: string
  /** Teléfono real del remitente (E.164 sin +) */
  senderPhone: string
  /** Número de la línea/bot que recibe */
  recipientNumber: string
  /** Texto del mensaje (vacío si es media sin caption) */
  body: string
  /** text | image | audio | ... */
  mediaType: string
  occurredAt: Date
  contactName: string | null
  /** Payload original completo (solo debug) */
  raw: unknown
}

/** Payload consolidado que se emite al expirar la ventana de debounce */
export interface ConsolidatedInbound {
  senderPhone: string
  /** Bodies de todos los mensajes unidos con '\n' */
  text: string
  messageCount: number
  firstAt: Date
  lastAt: Date
  messages: InboundMessage[]
}

export type DebounceFlushHandler = (consolidated: ConsolidatedInbound) => void | Promise<void>
