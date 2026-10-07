import env from '#start/env'
import logger from '@adonisjs/core/services/logger'
import redis from '@adonisjs/redis/services/main'
import {
  type InboundMessage,
  type ConsolidatedInbound,
  type DebounceFlushHandler,
} from '#services/inbound_message'

const WINDOW_MS = env.get('WHATSAPP_WEBHOOK_DEBOUNCE_MS', 3000)
const POLL_MS = 500
const BUFFER_PREFIX = 'debounce:buf:'
const READY_PREFIX = 'debounce:ready:'
const SEEN_PREFIX = 'debounce:seen:'

/**
 * Redis:
 *  - debounce:buf:{phone}      → list con un jsonb de InboundMessage por item
 *  - debounce:ready:{phone}    → string con epoch-ms cuando toca flush
 *  - debounce:seen:{provider}:{id} → dedupe (TTL 1h)
 */
const FLUSH_LUA = `
local readyAt = tonumber(redis.call('GET', KEYS[1]))
if not readyAt or readyAt > tonumber(ARGV[1]) then
  return nil
end
local items = redis.call('LRANGE', KEYS[2], 0, -1)
redis.call('DEL', KEYS[1], KEYS[2])
return items
`

interface MemoryBuffer {
  messages: InboundMessage[]
  readyAt: number
}

/**
 * Agrupa mensajes por teléfono con ventana re-armable "desde el último
 * mensaje". No sabe nada del proveedor: solo recibe `InboundMessage`.
 */
class SimpleMessageDebouncer {
  private flushHandler: DebounceFlushHandler | null = null
  private memoryBuffers = new Map<string, MemoryBuffer>()
  private poller: NodeJS.Timeout | null = null
  private fallbackMode = false

  setFlushHandler(handler: DebounceFlushHandler) {
    this.flushHandler = handler
  }

  /**
   * Guarda el mensaje en Redis (con re-armado de ventana y SEE a 1h)
   * y el fallback en memoria si Redis falla.
   */
  async push(msg: InboundMessage): Promise<void> {
    // Dedupe de reintentos del gateway
    const seenKey = `${SEEN_PREFIX}${msg.provider}:${msg.providerMessageId}`
    try {
      const created = await redis.connection('main').set(seenKey, '1', 'EX', 3600, 'NX')
      if (created === null) {
        logger.warn(
          { provider: msg.provider, messageId: msg.providerMessageId, phone: msg.senderPhone },
          'Mensaje duplicado (reintento) descartado por el dedupe'
        )
        return
      }
      await this.#pushToRedis(msg)
      logger.info(
        {
          provider: msg.provider,
          messageId: msg.providerMessageId,
          phone: msg.senderPhone,
          readyInMs: WINDOW_MS,
        },
        'Mensaje encolado en el debounce'
      )
      return
    } catch (error) {
      if (!this.fallbackMode) {
        console.warn('Redis caído, activando fallback en memoria para el debounce', error)
        this.fallbackMode = true
      }
      this.#pushToMemory(msg)
    }
  }

  async #pushToRedis(msg: InboundMessage): Promise<void> {
    const bufKey = `${BUFFER_PREFIX}${msg.senderPhone}`
    const readyKey = `${READY_PREFIX}${msg.senderPhone}`
    const connection = redis.connection('main')
    const pipeline = connection.multi()
    pipeline.rpush(bufKey, JSON.stringify(msg))
    pipeline.set(readyKey, String(Date.now() + WINDOW_MS))
    // TTL siempre mayor a la ventana: si expirara exacto, Redis borraría la
    // llave justo cuando el poller debe hacer flush. El Lua valida el tiempo.
    const ttl = Math.ceil(WINDOW_MS / 1000) + 60
    pipeline.expire(bufKey, ttl)
    pipeline.expire(readyKey, ttl)
    await pipeline.exec()
  }

  #pushToMemory(msg: InboundMessage) {
    const existing = this.memoryBuffers.get(msg.senderPhone) ?? { messages: [], readyAt: 0 }
    existing.messages.push(msg)
    existing.readyAt = Date.now() + WINDOW_MS
    this.memoryBuffers.set(msg.senderPhone, existing)
  }

  /** Corre el intervalo de flush para llaves listas. Solo una instancia lo llama. */
  startPoller() {
    if (this.poller) return
    logger.info({ windowMs: WINDOW_MS }, 'Poller del debouncer arrancado')
    this.poller = setInterval(() => {
      void this.#runPoll().catch((error) => {
        console.error('Error en el poll del debouncer', error)
      })
    }, POLL_MS)
    this.poller.unref()
  }

  async #runPoll(): Promise<void> {
    const handler = this.flushHandler
    if (!handler) return // no hay callback, no tiene sentido procesar

    // Modo fallback memoria hace el flush desde Map local
    if (this.fallbackMode) {
      const now = Date.now()
      for (const [phone, buf] of this.memoryBuffers) {
        if (buf.readyAt > now) continue
        this.memoryBuffers.delete(phone)
        await this.#emit(handler, {
          senderPhone: phone,
          text: buf.messages.map((m) => m.body).join('\n'),
          messageCount: buf.messages.length,
          firstAt: buf.messages[0].occurredAt,
          lastAt: buf.messages[buf.messages.length - 1].occurredAt,
          messages: buf.messages,
        })
      }
      return
    }

    // Redis: scan de llaves ready y flush atómico con Lua
    const connection = redis.connection('main')
    let cursor = '0'
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${READY_PREFIX}*`, 'COUNT', 100)
      cursor = next
      for (const readyKey of keys) {
        const phone = readyKey.replace(READY_PREFIX, '')
        const bufKey = `${BUFFER_PREFIX}${phone}`
        // LRANGE + DEL atómico: ni siquiera entre instancias hay doble flush
        const items = (await connection.eval(FLUSH_LUA, 2, readyKey, bufKey, Date.now())) as
          string[] | null
        if (!items) continue // no tocaba aún
        const messages = items.map((item) => {
          const parsed = JSON.parse(item) as InboundMessage
          return { ...parsed, occurredAt: new Date(parsed.occurredAt) }
        })
        await this.#emit(handler, {
          senderPhone: phone,
          text: messages.map((m) => m.body).join('\n'),
          messageCount: messages.length,
          firstAt: messages[0].occurredAt,
          lastAt: messages[messages.length - 1].occurredAt,
          messages,
        })
      }
    } while (cursor !== '0')
  }

  async #emit(handler: DebounceFlushHandler, payload: ConsolidatedInbound) {
    try {
      await handler(payload)
    } catch (error) {
      console.error('Error en el flush del debouncer', error)
    }
  }
}

export const messageDebouncer = new SimpleMessageDebouncer()
