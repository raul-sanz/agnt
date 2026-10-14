/**
 * Orquestador del agent: punto de entrada después del debounce.
 * Recibe el payload consolidado y ejecuta la lógica del agent por pasos.
 */
import { randomUUID } from 'node:crypto'
import logger from '@adonisjs/core/services/logger'
import redis from '@adonisjs/redis/services/main'
import Customer from '#models/customer'
import type { ConsolidatedInbound } from '#services/inbound_message'
import Conversation from '#models/conversation'
import Message from '#models/message'
import { conversationIdFromPhone, customerIdFromPhone } from '#services/agent_ids'
import { classifyIntent } from '#services/agent_intent_service'
import { runAppointmentAgent } from '#services/agent_appointment_service'
import { runGreetingAgent } from '#services/agent_greeting_service'
import { runInquiryAgent } from '#services/agent_inquiry_service'
import type { AgentContext } from '#services/agent_llm_service'

/**
 * Sujeto con el que se guardan los mensajes escritos por el usuario;
 * el agent escribe con subject 'assistant'.
 */
const SUBJECT_USER = 'user'

/**
 * Ventana del historial que se pasa a Jev para desambiguar respuestas
 * cortas. Del más viejo al más nuevo.
 */
const HISTORIAL_RECIENTE_MAX = 6

type HistoryTopic = { rol: 'usuario' | 'bot'; texto: string }

function textoDe(m: Message): string {
  return String((m.content as { text?: string })?.text ?? '').trim()
}

function asHistorico(m: Message): HistoryTopic {
  return { rol: m.subject === SUBJECT_USER ? 'usuario' : 'bot', texto: textoDe(m) }
}

/**
 * Lock serial por teléfono: garantiza que un turno N-1 haya guardado su
 * respuesta antes de que el turno N consulte el historial. Sin esto, el
 * flush del debouncer puede disparar un turno nuevo mientras el turno
 * anterior sigue vivo generando su reply con el LLM.
 *
 * - `agent:lock:{phone}`   → lock con token de dueño, TTL de seguridad
 * - Token + Lua en release: nunca suelta el lock de otro dueño (p. ej. si
 *   el TTL expiró, otro lo tomó y aún no termina).
 */
const LOCK_PREFIX = 'agent:lock:'
const LOCK_TTL_SECONDS = 120
const LOCK_WAIT_MS = 30_000
const LOCK_RETRY_MS = 100

const UNLOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

class AgentOrchestrator {
  /**
   * Se ejecuta cada vez que el debouncer agrupa los mensajes de un usuario.
   * Los turnos de un mismo teléfono corren en serie: el turno siguiente
   * espera a que el anterior haya guardado su respuesta en la DB.
   */
  async handle(consolidated: ConsolidatedInbound): Promise<void> {
    await this.#withPhoneLock(consolidated.senderPhone, () => this.#processTurn(consolidated))
  }

  async #processTurn(consolidated: ConsolidatedInbound): Promise<void> {
    logger.info(
      {
        phone: consolidated.senderPhone,
        messageCount: consolidated.messageCount,
        firstAt: consolidated.firstAt.toISOString(),
        lastAt: consolidated.lastAt.toISOString(),
        text: consolidated.text,
      },
      'Agent procesando mensajes consolidados'
    )

    const customer = await Customer.firstOrCreate(
      { id: customerIdFromPhone(consolidated.senderPhone) },
      { phone: consolidated.senderPhone, data: {} }
    )

    const conversation = await Conversation.firstOrCreate(
      { id: conversationIdFromPhone(consolidated.senderPhone) },
      { customerId: customer.id, status: 'new', isAgent: true }
    )

    await Message.create({
      conversationId: conversation.id,
      customerId: customer.id,
      subject: 'user',
      content: { text: consolidated.text },
    })

    const messages = await Message.query()
      .where('conversation_id', conversation.id)
      .orderBy('created_at', 'asc')

    logger.info(
      { customerId: customer.id, conversationId: conversation.id, messageCount: messages.length },
      'Customer resuelto para el agent'
    )

    // State para Jev: mensaje del turno + último mensaje del bot + ventana del
    // historial previa al turno. Con mantener el orden asc, todo lo guardado
    // previo al turno son mensajes 1..N-1 y el efímero del turno es el último.
    const historialPrevio = messages.slice(0, -1)
    const previosSoloLargo = historialPrevio.slice(-HISTORIAL_RECIENTE_MAX)
    const conTexto = previosSoloLargo.map(asHistorico).filter((m) => m.texto.length > 0)
    const mensajeAnteriorBot = [...conTexto].reverse().find((m) => m.rol === 'bot')?.texto ?? null

    const state = {
      mensaje_usuario: consolidated.text,
      mensaje_anterior_bot: mensajeAnteriorBot,
      historial_reciente: conTexto,
    }

    let decision: Awaited<ReturnType<typeof classifyIntent>>

    try {
      decision = await classifyIntent(state)
    } catch (error) {
      // Red/proveedor caído: no tumbar el agent, ir al fallback.
      logger.warn({ error }, 'Jev falló al clasificar; usando intent de fallback')
      decision = { intent: 'other', confidence: 0 }
    }

    const { intent, confidence } = decision
    logger.info({ intent, confidence }, 'Decisión de routing')

    const ctx: AgentContext = { customer, conversation, messages, consolidated }

    let reply: string
    switch (intent) {
      case 'appointment':
        reply = await runAppointmentAgent(ctx)
        break
      case 'inquiry':
        reply = await runInquiryAgent(ctx)
        break
      case 'other':
        reply = await runGreetingAgent(ctx)
        break
    }

    // Guardamos la respuesta como mensaje del agent: en el próximo turno
    // ya se incluye en el historial que se pasa a los agentes.
    await Message.create({
      conversationId: conversation.id,
      customerId: customer.id,
      subject: 'assistant',
      content: { text: reply },
    })

    // TODO: enviar la respuesta por WhatsApp (OpenWA) al usuario.
    logger.info({ intent, reply }, 'Respuesta del agent')
  }

  /**
   * Serializa los turnos por teléfono. Si el lock está tomado, espera
   * (el turno anterior puede estar generando su reply); si supera la
   * espera máxima, procesa igual para no dejar al usuario sin respuesta.
   */
  async #withPhoneLock<T>(phone: string, fn: () => Promise<T>): Promise<T> {
    const key = `${LOCK_PREFIX}${phone}`
    const token = randomUUID()
    const acquired = await this.#acquireLock(key, token)
    if (!acquired) {
      return fn()
    }
    try {
      return await fn()
    } finally {
      await this.#releaseLock(key, token)
    }
  }

  async #acquireLock(key: string, token: string): Promise<boolean> {
    const deadline = Date.now() + LOCK_WAIT_MS
    const redisConn = redis.connection('main')
    while (Date.now() < deadline) {
      try {
        const created = await redisConn.set(key, token, 'EX', LOCK_TTL_SECONDS, 'NX')
        if (created === 'OK') return true
      } catch (error) {
        logger.warn({ error, key }, 'Redis caído; procesando turno sin lock serial')
        return false
      }
      await sleep(LOCK_RETRY_MS)
    }
    logger.warn({ key }, 'Espera del lock serial expiró; procesando turno sin exclusión')
    return false
  }

  async #releaseLock(key: string, token: string): Promise<void> {
    try {
      await redis.connection('main').eval(UNLOCK_LUA, 1, key, token)
    } catch (error) {
      logger.warn({ error, key }, 'No se pudo liberar el lock serial (el TTL lo soltará)')
    }
  }
}

export const agentOrchestrator = new AgentOrchestrator()
