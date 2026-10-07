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
      { customerId: customer.id }
    )

    const messages = await Message.query()
      .where('conversation_id', conversation.id)
      .orderBy('created_at', 'asc')
    // Aquí sigue la lógica del agent usando el customer (y su conversación)
    logger.info(
      { customerId: customer.id, conversationId: conversation.id, messages: messages },
      'Customer resuelto para el agent'
    )
  }
}

export const agentOrchestrator = new AgentOrchestrator()
