import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import { AppointmentSchema } from '#database/schema'
import Calendar from '#models/calendar'
import Conversation from '#models/conversation'
import Customer from '#models/customer'
import Patient from '#models/patient'

export default class Appointment extends AppointmentSchema {
  @belongsTo(() => Customer)
  declare customer: BelongsTo<typeof Customer>

  @belongsTo(() => Patient)
  declare patient: BelongsTo<typeof Patient>

  @belongsTo(() => Conversation)
  declare conversation: BelongsTo<typeof Conversation>

  @belongsTo(() => Calendar)
  declare calendar: BelongsTo<typeof Calendar>
}
