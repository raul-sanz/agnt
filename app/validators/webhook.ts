import vine from '@vinejs/vine'

/**
 * Validador del payload del webhook de OpenWA ("message.received").
 * Campos esenciales requeridos; el resto optional/nullable para
 * tolerar variaciones del gateway. Los textos internos están en
 * español de Mexico para mantener consistencia con el proyecto.
 */
export const openwaWebhookValidator = vine.create({
  event: vine.string(),
  timestamp: vine.string().optional(),
  sessionId: vine.string().optional(),
  idempotencyKey: vine.string().optional(),
  deliveryId: vine.string().optional(),
  data: vine.object({
    id: vine.string(),
    from: vine.string(),
    to: vine.string(),
    chatId: vine.string(),
    body: vine.string().nullable().optional(),
    type: vine.string().optional(),
    timestamp: vine.number(),
    fromMe: vine.boolean(),
    isGroup: vine.boolean(),
    isStatusBroadcast: vine.boolean().optional(),
    contact: vine
      .object({
        pushName: vine.string().nullable().optional(),
        number: vine.string().optional(),
      })
      .optional(),
    senderPhone: vine.string().optional(),
  }),
})
