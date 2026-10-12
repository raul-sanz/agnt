/**
 * Orquestador del agent: punto de entrada después del debounce.
 * Recibe el payload consolidado y ejecuta la lógica del agent por pasos.
 */
import { v5 as uuidV5 } from 'uuid'
import logger from '@adonisjs/core/services/logger'
import Customer from '#models/customer'
import type { ConsolidatedInbound } from '#services/inbound_message'
import Conversation from '#models/conversation'
import Message from '#models/message'
import { classifyIntent } from '#services/agent_intent_service'
import { runAppointmentAgent } from '#services/agent_appointment_service'
import { runGreetingAgent } from '#services/agent_greeting_service'
import { runInquiryAgent } from '#services/agent_inquiry_service'
import type { AgentContext } from '#services/agent_llm_service'

/**
 * Namespace fijo para todos los IDs deterministas del agent.
 * Debe NUNCA cambiar: si cambia, cambian todos los IDs generados.
 */
const AGENT_UUID_NAMESPACE = '1b671a64-40d5-491e-99b0-da01ff1f3341'

/**
 * ID determinista del customer a partir de su teléfono:
 * mismo teléfono → mismo UUID siempre (uuid v5 = nombre + namespace).
 */
function customerIdFromPhone(phone: string): string {
  return uuidV5(`customer:${phone}`, AGENT_UUID_NAMESPACE)
}

function conversationIdFromPhone(phone: string): string {
  return uuidV5(`conversation:${phone}`, AGENT_UUID_NAMESPACE)
}

class AgentOrchestrator {
  /**
   * Se ejecuta cada vez que el debouncer agrupa los mensajes de un usuario.
   */
  async handle(consolidated: ConsolidatedInbound): Promise<void> {
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

    const state = {
      text: consolidated.text,
      messageCount: consolidated.messageCount,
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
}

export const agentOrchestrator = new AgentOrchestrator()
