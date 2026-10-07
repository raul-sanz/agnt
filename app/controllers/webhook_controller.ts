import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import { openwaToInbound } from '#mappers/openwa_inbound_mapper'
import { messageDebouncer } from '#services/message_debouncer_service'
import { openwaWebhookValidator } from '#validators/webhook'

export default class WebhookController {
  /**
   * Recibe webhooks de OpenWA. Responde rápido al gateway; el
   * procesamiento real ocurre después del debounce en Redis.
   */
  async store({ request, response }: HttpContext) {
    const payload = await request.validateUsing(openwaWebhookValidator)

    // Solo mensajes individuales entrantes interesan para el debouncer
    const ignoreResponse = { received: true, processed: false }
    if (
      payload.event !== 'message.received' ||
      payload.data.fromMe ||
      payload.data.isGroup ||
      payload.data.isStatusBroadcast === true
    ) {
      return response.status(204).send(ignoreResponse)
    }

    const inbound = openwaToInbound(payload)
    await messageDebouncer.push(inbound)

    logger.debug(
      {
        phone: inbound.senderPhone,
        controller: 'webhook',
      },
      'Mensaje entrante en cola de debounce'
    )

    return response.status(200).json({ received: true, processed: true })
  }
}
