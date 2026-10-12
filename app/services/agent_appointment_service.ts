/**
 * Agente de citas: conversa con el usuario para agendar, mover o cancelar
 * citas usando el SDK de Vercel AI.
 *
 * TODO: las herramientas (disponibilidad, agendar) son FAKE.
 * Cuando exista la integración real (calendarios, pacientes), reemplazar
 * los `execute` por las llamadas reales de la DB/servicios.
 */
import { generateText, stepCountIs, tool } from 'ai'
import logger from '@adonisjs/core/services/logger'
import { z } from 'zod'

import { AGENT_MODEL, openai, toModelMessages } from '#services/agent_llm_service'
import type { AgentContext } from '#services/agent_llm_service'

const INSTRUCTIONS = `Eres el recepcionista virtual de una clínica dental y atiendes por WhatsApp.
- Tu único rol es agendar, mover o cancelar citas.
- Responde en español, muy corto y natural (estilo WhatsApp).
- Pregunta lo mínimo necesario: servicio, horario, nombre del paciente.
- Usa la herramienta de disponibilidad ANTES de proponer horarios.
- NO prometas horarios que no estén en la lista de disponibilidad.
- Cuando el usuario confirme, agenda con la herramienta y confirma con fecha, hora y servicio exactos.`

export async function runAppointmentAgent(ctx: AgentContext): Promise<string> {
  const result = await generateText({
    model: openai(AGENT_MODEL),
    instructions: INSTRUCTIONS,
    messages: toModelMessages(ctx),
    tools: {
      get_available_slots: tool({
        description: 'Devuelve los horarios disponibles en la agenda de la clínica',
        inputSchema: z.object({
          day: z.string().describe('Día para consultar, formato YYYY-MM-DD'),
        }),
        execute: async ({ day }) => {
          // TODO: fake — reemplazar por consulta real a calendarios.
          logger.info({ day }, 'FAKE get_available_slots')
          return { slots: ['09:00', '11:30', '15:00'] }
        },
      }),
      book_appointment: tool({
        description: 'Agenda la cita del paciente en la clínica',
        inputSchema: z.object({
          service: z.string().describe('Servicio solicitado (limpieza, consulta, etc.)'),
          day: z.string().describe('Día de la cita, formato YYYY-MM-DD'),
          time: z.string().describe('Hora de la cita, formato HH:mm'),
          patientName: z.string().describe('Nombre del paciente'),
        }),
        execute: async (booking) => {
          // TODO: fake — reemplazar por creación real de Appointment en DB.
          logger.info({ booking }, 'FAKE book_appointment')
          return {
            ok: true,
            appointmentId: 'fake-' + Math.random().toString(36).slice(2, 10),
          }
        },
      }),
      cancel_appointment: tool({
        description: 'Cancela una cita existente del paciente',
        inputSchema: z.object({
          appointmentId: z.string().describe('Identificador de la cita a cancelar'),
        }),
        execute: async ({ appointmentId }) => {
          // TODO: fake — reemplazar por cancelación real en DB.
          logger.info({ appointmentId }, 'FAKE cancel_appointment')
          return { ok: true }
        },
      }),
    },
    stopWhen: [stepCountIs(5)],
  })

  logger.info(
    { intent: 'appointment', usage: result.usage, steps: result.steps.length, reply: result.text },
    'Agente de citas respondió'
  )
  return result.text
}
