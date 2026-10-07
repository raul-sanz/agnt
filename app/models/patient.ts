import { hasMany } from '@adonisjs/lucid/orm'
import type { HasMany } from '@adonisjs/lucid/types/relations'

import { PatientSchema } from '#database/schema'
import Appointment from '#models/appointment'

export default class Patient extends PatientSchema {
  static table = 'patient'

  @hasMany(() => Appointment)
  declare appointments: HasMany<typeof Appointment>
}
