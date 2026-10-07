import { hasMany } from '@adonisjs/lucid/orm'
import type { HasMany } from '@adonisjs/lucid/types/relations'

import { CalendarSchema } from '#database/schema'
import Appointment from '#models/appointment'

export default class Calendar extends CalendarSchema {
  @hasMany(() => Appointment)
  declare appointments: HasMany<typeof Appointment>
}
