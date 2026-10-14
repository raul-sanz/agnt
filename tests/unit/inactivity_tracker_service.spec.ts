import { test } from '@japa/runner'
import redis from '@adonisjs/redis/services/main'
import { inactivityTracker } from '#services/inactivity_tracker_service'

test.group('Inactivity tracker', (group) => {
  const phones: string[] = []
  group.each.setup(async () => {
    inactivityTracker.setLapsesForTesting([200, 300])
    await redis.keys('inactivity:*').then((keys) => (keys.length ? redis.del(...keys) : null))
  })
  group.each.teardown(async () => {
    for (const phone of phones) {
      await redis.connection('main').del(`inactivity:${phone}`)
    }
    phones.length = 0
  })

  test('dispara el primer lapso cuando no hay actividad', async ({ assert }) => {
    const fired: number[] = []
    inactivityTracker.setLapseHandler((event) => {
      fired.push(event.level)
      return Promise.resolve()
    })
    const phone = '521test100'
    phones.push(phone)
    await inactivityTracker.recordActivity(phone)
    // Antes del lapso no dispara
    await inactivityTracker.runPollOnce()
    assert.deepEqual(fired, [])
    // Espera el lapso (200ms) y dispara
    await new Promise((resolve) => setTimeout(resolve, 350))
    await inactivityTracker.runPollOnce()
    assert.deepEqual(fired, [0])
  })

  test('la escalera avanza de nivel sin actividad del usuario', async ({ assert }) => {
    const fired: number[] = []
    inactivityTracker.setLapseHandler((event) => {
      fired.push(event.level)
      return Promise.resolve()
    })
    const phone = '521test200'
    phones.push(phone)
    await inactivityTracker.recordActivity(phone)
    await new Promise((resolve) => setTimeout(resolve, 350))
    await inactivityTracker.runPollOnce()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await inactivityTracker.runPollOnce()
    assert.deepEqual(fired.sort(), [0, 1])
  })

  test('un mensaje del usuario resetea al nivel 0', async ({ assert }) => {
    const fired: number[] = []
    inactivityTracker.setLapseHandler((event) => {
      fired.push(event.level)
      return Promise.resolve()
    })
    const phone = '521test300'
    phones.push(phone)
    await inactivityTracker.recordActivity(phone)
    await new Promise((resolve) => setTimeout(resolve, 350))
    await inactivityTracker.runPollOnce()
    assert.deepEqual(fired, [0])
    // Vuelve a escribir: se resetea al nivel 0 y vuelve a disparar el primer lapso
    await inactivityTracker.recordActivity(phone)
    fired.length = 0
    await inactivityTracker.runPollOnce()
    assert.deepEqual(fired, [])
    await new Promise((resolve) => setTimeout(resolve, 350))
    await inactivityTracker.runPollOnce()
    assert.deepEqual(fired, [0])
  })
})
