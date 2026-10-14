/**
 * Clasificación de intención del mensaje consolidado usando Jev (System One).
 *
 * Aquí NO hay lógica de negocio: solo se hace el juicio semántico.
 * La decisión de qué agente (Vercel AI SDK) ejecutar según la respuesta
 * se hace en el orquestador, en código normal.
 */
import { choice, TypeSafeClient } from '@typesafe-ai/sdk'
import logger from '@adonisjs/core/services/logger'

/**
 * Intenciones reconocidas. Agregar una nueva = agregar la key aquí
 * (con su descripción) y manejarla en el routing del orquestador.
 * Las descripciones son lo que Jev usa para separar opciones: dejarlas
 * en null provoca probabilidad esparcida y confidence bajo.
 */
export const AGENT_INTENT_CRITERIA = {
  /** Quizá/agendar/mover/cancelar una cita */
  appointment:
    'Quiere agendar, mover o cancelar una cita; eligió o propone fecha/horario; o responde a algo que el bot le preguntó sobre disponibilidad o confirmación de cita.',
  /** Pregunta informativa (horarios, servicios, precios, ubicación) */
  inquiry:
    'Pregunta información: horarios de atención, servicios, precios, promociones, ubicación, referencias o qué incluye una consulta.',
  /** Saludo o algo que no entra en ninguna categoría */
  other: 'Saludo, agradecimiento, despedida, o algo que no encaja en las otras dos categorías.',
} as const

export type AgentIntent = keyof typeof AGENT_INTENT_CRITERIA

/**
 * Estado que Jev evalúa para enrutar. La clave es incluir el último
 * mensaje del bot: sin él, respuestas cortas del usuario ('Sí', 'Ok',
 * 'Link', 'Mañana') son ininterpretables.
 */
export interface IntentState {
  [key: string]: string | null | { rol: 'usuario' | 'bot'; texto: string }[]
  /** Texto consolidado del usuario en este turno */
  mensaje_usuario: string
  /** Último texto que envió el bot antes de este turno (null si es el primero) */
  mensaje_anterior_bot: string | null
  /** Ventana del historial previo al turno, del más viejo al más nuevo */
  historial_reciente: { rol: 'usuario' | 'bot'; texto: string }[]
}

const client = new TypeSafeClient()

export interface IntentDecision {
  intent: AgentIntent
  confidence: number
}

export async function classifyIntent(state: IntentState): Promise<IntentDecision> {
  const response = await client.systemOne({
    state,
    questions: {
      intent: choice(
        '¿Qué intenta el usuario (mensaje_usuario) en este mensaje de WhatsApp de una clínica odontológica? Usa mensaje_anterior_bot e historial_reciente para interpretar respuestas cortas como "Sí", "Ok", "Link" o "Mañana": si el mensaje responde directamente a lo que el bot acaba de preguntar o proponer, elige la categoría de ese paso de la conversación.',
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
