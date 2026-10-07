import { hasMany } from '@adonisjs/lucid/orm'
import type { HasMany } from '@adonisjs/lucid/types/relations'

import { CustomerSchema } from '#database/schema'
import Appointment from '#models/appointment'

export default class Customer extends CustomerSchema {
  @hasMany(() => Patient)
  declare patients: HasMany<typeof Patient>

  @hasMany(() => Conversation)
  declare conversations: HasMany<typeof Conversation>

  @hasMany(() => Message)
  declare messages: HasMany<typeof Message>

  @hasMany(() => Appointment)
  declare appointments: HasMany<typeof Appointment>
}

import Conversation from '#models/conversation'
import Message from '#models/message'
import Patient from '#models/patient'
