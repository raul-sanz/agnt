import { test } from '@japa/runner'
import redis from '@adonisjs/redis/services/main'
import { messageDebouncer } from '#services/message_debouncer_service'
import type { ConsolidatedInbound, InboundMessage } from '#services/inbound_message'

function makeMsg(id: string, body: string, phone = '5219511111111'): InboundMessage {
  return {
    provider: 'openwa',
    providerMessageId: id,
    conversationId: `${phone}@lid`,
    senderPhone: phone,
    recipientNumber: '15403563171',
    body,
    mediaType: 'text',
    occurredAt: new Date(),
    contactName: 'Test',
    raw: null,
  }
}

test.group('Message debouncer', (group) => {
  group.each.teardown(async () => {
    const keys = await redis.keys('debounce:*')
    if (keys.length > 0) {
      await redis.del(...keys)
    }
  })

  test('deduplica reintentos con el mismo providerMessageId', async ({ assert }) => {
    await messageDebouncer.push(makeMsg('unit_dup_1', 'uno'))
    await messageDebouncer.push(makeMsg('unit_dup_1', 'uno'))
    assert.equal(await redis.llen('debounce:buf:5219511111111'), 1)
  })

  test('re-arma la ventana con cada mensaje y emite un consolidado', async ({ assert }) => {
    let flushes = 0
    let capturado: ConsolidatedInbound | null = null
    messageDebouncer.setFlushHandler((payload) => {
      flushes++
      capturado = payload
    })
    messageDebouncer.startPoller()

    await messageDebouncer.push(makeMsg('unit_fl_1', 'hola'))
    await new Promise((resolve) => setTimeout(resolve, 1200))
    await messageDebouncer.push(makeMsg('unit_fl_2', 'de nuevo'))

    await new Promise((resolve) => setTimeout(resolve, 4500))

    assert.equal(flushes, 1)
    assert.isNotNull(capturado)
    assert.equal(capturado!.text, 'hola\nde nuevo')
    assert.equal(capturado!.messageCount, 2)
  })
})
