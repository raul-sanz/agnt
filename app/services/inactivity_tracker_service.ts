import env from '#start/env'
import logger from '@adonisjs/core/services/logger'
import redis from '@adonisjs/redis/services/main'

/**
 * Escalera de lapsos de inactividad por conversación. Lapso 0 = primer
 * tiempo de inactividad tras la última actividad del usuario; a partir
 * de ahí cada nivel saltará al siguiente aunque el usuario no escriba.
 *
 * Para pruebas se puede acortar el primer lapso con
 * `INACTIVITY_FIRST_LAPSE_MS` en `.env` (ej. 120000 = 2 min).
 */
const LAPSES_MS = [
  env.get('INACTIVITY_FIRST_LAPSE_MS', 30 * 60_000),
  60 * 60_000, // 1h
  3 * 60 * 60_000, // 3h
  12 * 60 * 60_000, // 12h
  24 * 60 * 60_000, // 24h
  72 * 60 * 60_000, // 72h
] as number[]

const KEY_PREFIX = 'inactivity:'
const POLL_MS = 5_000

/**
 * Redis: hash por teléfono.
 *  - inactivity:{phone} → lastActivityAt (epoch-ms), level (índice del lapso en curso)
 *
 * Lua atómico: si la inactividad alcanzó el lapso del nivel actual, avanza
 * el nivel (o borra la llave si ya no quedan lapsos) y devuelve el nivel
 * disparado. Entre instancias nunca se dispara dos veces el mismo nivel.
 */
const FIRE_LUA = `
local level = tonumber(redis.call('HGET', KEYS[1], 'level'))
if not level then return nil end
local lapses = {}
for i = 2, #ARGV do lapses[#lapses + 1] = tonumber(ARGV[i]) end
local lastAt = tonumber(redis.call('HGET', KEYS[1], 'lastActivityAt'))
if not lastAt then return nil end
local nextLevel = level + 1
if nextLevel >= #lapses then
  redis.call('DEL', KEYS[1])
  return level
end
local nextLapse = lapses[nextLevel]
if tonumber(ARGV[1]) - lastAt < nextLapse then return nil end
redis.call('HSET', KEYS[1], 'level', nextLevel)
redis.call('EXPIRE', KEYS[1], math.ceil(nextLapse / 1000) + 60)
return level
`

export interface InactivityLapseEvent {
  phone: string
  /** Milisegundos de inactividad configurados para el nivel disparado */
  lapseMs: number
  /** Índice del nivel disparado (0 = primer lapso) */
  level: number
}

type InactivityLapseHandler = (event: InactivityLapseEvent) => void | Promise<void>

const TOTAL_LADDER_MS = LAPSES_MS.reduce((sum, ms) => sum + ms, 0)
const BASE_TTL = Math.ceil(TOTAL_LADDER_MS / 1000) + 60

interface MemoryState {
  lastActivityAt: number
  level: number
}

/**
 * Registra actividad por conversación y dispara la escalera de lapsos de
 * inactividad. Un mensaje nuevo del usuario reinicia al nivel 0.
 * Fallback a Map en memoria si Redis está caído (se pierde al reiniciar).
 */
class InactivityTracker {
  /** Escalera en curso (mutable por tests vía `setLapsesForTesting`) */
  private lapses = LAPSES_MS
  private handler: InactivityLapseHandler = (event) => {
    logger.info(event, 'Lapso de inactividad alcanzado (sin handler configurado)')
  }
  private memory = new Map<string, MemoryState>()
  private poller: NodeJS.Timeout | null = null
  private fallbackMode = false

  /** Registra la función a ejecutar cuando se cumple un lapso. */
  setLapseHandler(handler: InactivityLapseHandler) {
    this.handler = handler
  }

  /**
   * Marca actividad del usuario: resetea al nivel 0. Llamarlo en cada
   * mensaje entrante del usuario (antes de correr un turno).
   */
  async recordActivity(phone: string): Promise<void> {
    try {
      const key = `${KEY_PREFIX}${phone}`
      await redis
        .connection('main')
        .multi()
        .hset(key, { lastActivityAt: Date.now().toString(), level: 0 })
        .expire(key, BASE_TTL)
        .exec()
      return
    } catch (error) {
      if (!this.fallbackMode) {
        console.warn(
          'Redis caído, activando fallback en memoria para el tracker de inactividad',
          error
        )
        this.fallbackMode = true
      }
      this.memory.set(phone, { lastActivityAt: Date.now(), level: 0 })
    }
  }

  /** Override de la escalera para tests. */
  setLapsesForTesting(lapses: number[]) {
    this.lapses = lapses
  }

  /** Ejecuta un ciclo completo del poll de forma manual (útil en tests). */
  async runPollOnce(): Promise<void> {
    await this.#runPoll()
  }

  /** Corre el intervalo que revisa lapsos cumplidos. Solo una instancia lo llama. */
  startPoller() {
    if (this.poller) return
    logger.info({ lapsesMs: this.lapses }, 'Poller de inactividad arrancado')
    this.poller = setInterval(() => {
      void this.#runPoll().catch((error) => {
        console.error('Error en el poll de inactividad', error)
      })
    }, POLL_MS)
    this.poller.unref()
  }

  async #runPoll(): Promise<void> {
    if (this.fallbackMode) {
      for (const [phone, state] of this.memory) {
        const due = this.lapses[state.level]
        if (Date.now() - state.lastActivityAt < due) continue
        const nextLevel = state.level + 1
        if (nextLevel >= this.lapses.length) {
          this.memory.delete(phone)
        } else {
          this.memory.set(phone, { ...state, level: nextLevel })
        }
        await this.#fire(phone, state.level)
      }
      return
    }

    const connection = redis.connection('main')
    let cursor = '0'
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 100)
      cursor = next
      for (const key of keys) {
        const phone = key.replace(KEY_PREFIX, '')
        const firedLevel = (await connection.eval(FIRE_LUA, 1, key, Date.now(), ...this.lapses)) as
          number | null
        if (firedLevel === null) continue
        await this.#fire(phone, Number(firedLevel))
      }
    } while (cursor !== '0')
  }

  async #fire(phone: string, level: number) {
    const lapseMs = this.lapses[level]
    try {
      await this.handler({ phone, lapseMs, level })
      logger.info({ phone, level, lapseMs }, 'Lapso de inactividad disparado')
    } catch (error) {
      console.error('Error en el handler de inactividad', error)
    }
  }
}

export const inactivityTracker = new InactivityTracker()
