import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import { MessageSchema } from '#database/schema'

export default class Message extends MessageSchema {
  @belongsTo(() => Customer)
  declare customer: BelongsTo<typeof Customer>

  @belongsTo(() => Conversation)
  declare conversation: BelongsTo<typeof Conversation>
}

import Conversation from '#models/conversation'
import Customer from '#models/customer'
