/**
 * Agente de saludos / fallback: atiende mensajes que no son de citas
 * ni preguntas informativas (saludos, agradecimientos, cortesía).
 */
import { generateText } from 'ai'
import logger from '@adonisjs/core/services/logger'

import { AGENT_MODEL, openai, toModelMessages } from '#services/agent_llm_service'
import type { AgentContext } from '#services/agent_llm_service'

const INSTRUCTIONS = `Eres el recepcionista virtual de una clínica dental y atiendes por WhatsApp.
- Tu rol aquí es solo conversación breve: saludar, agradecer, despedir, conversación de cortesía.
- En saludos, preséntate una vez como el asistente de la clínica y ofrece mar una cita o resolver dudas.
- NO agendes citas y NO respondas preguntas complejas sobre la clínica: avisa que en breve le ayudan.
- Responde en español, con mensajes muy cortos y naturales (estilo WhatsApp).`

export async function runGreetingAgent(ctx: AgentContext): Promise<string> {
  const result = await generateText({
    model: openai(AGENT_MODEL),
    instructions: INSTRUCTIONS,
    messages: toModelMessages(ctx),
  })

  logger.info(
    { intent: 'other', usage: result.usage, reply: result.text },
    'Agente de saludos respondió'
  )
  return result.text
}
