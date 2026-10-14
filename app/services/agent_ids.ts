/**
 * IDs deterministas del agent a partir del teléfono del usuario.
 * Mismo teléfono → mismos UUIDs siempre (uuid v5 = nombre + namespace),
 * así que cualquier módulo puede derivar los IDs sin consultar la DB.
 */
import { v5 as uuidV5 } from 'uuid'

/**
 * Namespace fijo para todos los IDs deterministas del agent.
 * Debe NUNCA cambiar: si cambia, cambian todos los IDs generados.
 */
export const AGENT_UUID_NAMESPACE = '1b671a64-40d5-491e-99b0-da01ff1f3341'

export function customerIdFromPhone(phone: string): string {
  return uuidV5(`customer:${phone}`, AGENT_UUID_NAMESPACE)
}

export function conversationIdFromPhone(phone: string): string {
  return uuidV5(`conversation:${phone}`, AGENT_UUID_NAMESPACE)
}
