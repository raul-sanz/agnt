import { test } from '@japa/runner'
import redis from '@adonisjs/redis/services/main'

const basePayload = {
  event: 'message.received',
  timestamp: '2026-09-25T04:40:35.931Z',
  sessionId: '2858f19c-48bc-4fef-9cb2-c6fa83376c48',
  idempotencyKey: 'msg_test_key_1',
  deliveryId: 'dlv_test_1',
  data: {
    id: 'false_test_msg_1',
    from: '5219511576761@lid',
    to: '15403563171@c.us',
    chatId: '5219511576761@lid',
    body: 'prueba',
    type: 'text',
    timestamp: 1790397635,
    fromMe: false,
    isGroup: false,
    kind: 'individual',
    contact: {
      pushName: 'RaulSanz',
      number: '5219511576761',
      type: 'in',
    },
    senderPhone: '5219511576761',
  },
}

test.group('Webhook OpenWA', (group) => {
  group.each.setup(async () => {
    // Limpieza de llaves del debounce antes de cada test para no contaminar corridas
    const keys = await redis.keys('debounce:*')
    if (keys.length > 0) {
      await redis.del(...keys)
    }
  })

  test('responde 200 y encola en Redis un mensaje válido', async ({ client, assert }) => {
    const payload = {
      ...basePayload,
      data: { ...basePayload.data, id: 'false_test_msg_a1', idempotencyKey: 'msg_test_a1' },
    }
    const response = await client.post('/api/webhooks/openwa').json(payload)
    response.assertStatus(200)
    response.assertBodyContains({ received: true })
    assert.equal(await redis.llen('debounce:buf:5219511576761'), 1)
  })

  test('ignora mensajes fromMe con 204', async ({ client, assert }) => {
    const payload = {
      ...basePayload,
      data: { ...basePayload.data, id: 'false_test_msg_b1', fromMe: true },
    }
    const response = await client.post('/api/webhooks/openwa').json(payload)
    response.assertStatus(204)
    assert.equal(await redis.llen('debounce:buf:5219511576761'), 0)
  })

  test('ignora eventos distintos a message.received con 204', async ({ client, assert }) => {
    const response = await client
      .post('/api/webhooks/openwa')
      .json({ ...basePayload, event: 'typing.started' })
    response.assertStatus(204)
    assert.equal(await redis.llen('debounce:buf:5219511576761'), 0)
  })

  test('agrupa dos mensajes del mismo teléfono y los procesa tras la ventana', async ({
    client,
    assert,
  }) => {
    const m1 = {
      ...basePayload,
      data: { ...basePayload.data, id: 'false_test_msg_c1', body: 'hola' },
    }
    const m2 = {
      ...basePayload,
      data: { ...basePayload.data, id: 'false_test_msg_c2', body: 'disculpa' },
    }
    await client.post('/api/webhooks/openwa').json(m1)
    await client.post('/api/webhooks/openwa').json(m2)
    assert.equal(await redis.llen('debounce:buf:5219511576761'), 2)

    // Espera al poller con ventana 3000ms + margen
    await new Promise((resolve) => setTimeout(resolve, 4200))
    assert.equal(await redis.llen('debounce:buf:5219511576761'), 0)
  })
})
