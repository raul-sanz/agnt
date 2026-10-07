import { type Infer } from '@vinejs/vine/types'
import { type InboundMessage } from '#services/inbound_message'
import { type openwaWebhookValidator } from '#validators/webhook'

type OpenwaPayload = Infer<typeof openwaWebhookValidator>

/**
 * Único archivo que conoce el payload de OpenWA. Traduce el payload
 * validado al shape global `InboundMessage`. Cambiar de proveedor =
 * crear `xxx_inbound_mapper.ts` y su validador; nada más toca el resto.
 */
export function openwaToInbound(payload: OpenwaPayload): InboundMessage {
  return {
    provider: 'openwa',
    providerMessageId: payload.data.id,
    conversationId: payload.data.chatId,
    senderPhone: payload.data.senderPhone ?? payload.data.from,
    recipientNumber: payload.data.to.split('@')[0] ?? '',
    body: payload.data.body ?? '',
    mediaType: payload.data.type ?? 'text',
    occurredAt: new Date(payload.data.timestamp * 1000),
    contactName: payload.data.contact?.pushName ?? null,
    raw: payload,
  }
}
