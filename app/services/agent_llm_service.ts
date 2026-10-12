/**
 * Infraestructura compartida por los agentes de IA:
 * cliente OpenAI (SDK de Vercel AI), modelo y contexto común.
 */
import { createOpenAI } from '@ai-sdk/openai'
import type { ModelMessage } from 'ai'

import type Customer from '#models/customer'
import type Conversation from '#models/conversation'
import type Message from '#models/message'
import type { ConsolidatedInbound } from '#services/inbound_message'

/**
 * Cliente OpenAI compartido. Lee OPENAI_API_KEY del entorno.
 */
export const openai = createOpenAI()

/**
 * Modelo por defecto para los agentes (configurable con AGENT_OPENAI_MODEL).
 */
export const AGENT_MODEL = process.env.AGENT_OPENAI_MODEL || 'gpt-4o-mini'

/**
 * Contexto común que reciben todos los agentes al rutearlos.
 */
export interface AgentContext {
  customer: Customer
  conversation: Conversation
  /** Historial completo de la conversación, ordenado asc */
  messages: Message[]
  consolidated: ConsolidatedInbound
}

/**
 * Convierte el historial almacenado en Lucid al formato de mensajes del SDK.
 */
export function toModelMessages(ctx: AgentContext): ModelMessage[] {
  const roleBySubject = { user: 'user' as const, assistant: 'assistant' as const }
  return ctx.messages
    .map((m) => ({
      role: roleBySubject[m.subject === 'user' ? 'user' : 'assistant'],
      content: String((m.content as { text?: string })?.text ?? ''),
    }))
    .filter((m) => m.content.length > 0)
}
