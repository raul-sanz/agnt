/**
 * Clasificación de intención del mensaje consolidado usando Jev (System One).
 *
 * Aquí NO hay lógica de negocio: solo se hace el juicio semántico.
 * La decisión de qué agente (Vercel AI SDK) ejecutar según la respuesta
 * se hace en el orquestador, en codigo normal.
 */
import { choice, TypeSafeClient } from '@typesafe-ai/sdk'
import logger from '@adonisjs/core/services/logger'

/**
 * Intenciones reconocidas. Agregar una nueva = agregar la key aquí
 * y manejarla en el routing del orquestador.
 */
export const AGENT_INTENT_CRITERIA = {
  /** Quizá/agendar/mover/cancelar una cita */
  appointment: null,
  /** Pregunta informativa (horarios, servicios, precios, ubicación) */
  inquiry: null,
  /** Saludo o algo que no entra en ninguna categoría */
  other: null,
} as const

export type AgentIntent = keyof typeof AGENT_INTENT_CRITERIA

const client = new TypeSafeClient()

export interface IntentDecision {
  intent: AgentIntent
  confidence: number
}

export async function classifyIntent(state: {
  text: string
  messageCount: number
}): Promise<IntentDecision> {
  const response = await client.systemOne({
    state,
    questions: {
      intent: choice(
        '¿Sobre qué trata este mensaje de WhatsApp de una clínica?',
        AGENT_INTENT_CRITERIA
      ),
    },
  })

  const answer = response.answers.intent
  const intent = answer.choice as AgentIntent

  logger.info(
    { intent, confidence: answer.confidence, probabilities: answer.probabilities },
    'Jev clasificó la intención'
  )
  return { intent, confidence: answer.confidence }
}
