import { belongsTo, hasMany } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasMany } from '@adonisjs/lucid/types/relations'

import { ConversationSchema } from '#database/schema'
import Customer from '#models/customer'

export default class Conversation extends ConversationSchema {
  @belongsTo(() => Customer)
  declare customer: BelongsTo<typeof Customer>

  @hasMany(() => Message)
  declare messages: HasMany<typeof Message>

  @hasMany(() => Appointment)
  declare appointments: HasMany<typeof Appointment>
}

import Appointment from '#models/appointment'
import Message from '#models/message'
