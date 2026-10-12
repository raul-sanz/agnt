/**
 * Agente de preguntas: responde dudas informativas de la clínica
 * (horarios, servicios, precios, ubicación) usando el SDK de Vercel AI.
 */
import { generateText } from 'ai'
import logger from '@adonisjs/core/services/logger'

import { AGENT_MODEL, openai, toModelMessages } from '#services/agent_llm_service'
import type { AgentContext } from '#services/agent_llm_service'

const INSTRUCTIONS = `Eres el recepcionista virtual de una clínica dental y atiendes por WhatsApp.
- Responde en español, con mensajes cortos y naturales (estilo WhatsApp).
- Responde dudas informativas: horarios, servicios, precios, ubicación.
- Si te agregan agendar, cancelar o mover una cita, pídele al usuario que lo pregunte directamente o avisa que en breve le ayudan con eso.
- NO inventes información que no tengas. Si no la sabes, ofrece contactar al personal.
- Sé amable y cercano.`

export async function runInquiryAgent(ctx: AgentContext): Promise<string> {
  const result = await generateText({
    model: openai(AGENT_MODEL),
    instructions: INSTRUCTIONS,
    messages: toModelMessages(ctx),
  })

  logger.info(
    { intent: 'inquiry', usage: result.usage, reply: result.text },
    'Agente de preguntas respondió'
  )
  return result.text
}
