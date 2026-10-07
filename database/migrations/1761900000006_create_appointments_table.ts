import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'appointments'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table.timestamp('start_at', { useTz: true }).notNullable()
      table.timestamp('end_at', { useTz: true }).notNullable()
      table.specificType('ts_range', 'tstzrange').notNullable()
      table.uuid('customer_id').notNullable().references('id').inTable('customers')
      table.uuid('patient_id').notNullable().references('id').inTable('patient')
      table.uuid('conversation_id').notNullable().references('id').inTable('conversations')
      table.text('status').notNullable()
      table.uuid('external_id').notNullable()
      table.boolean('appointment').notNullable().defaultTo(true)
      table.jsonb('data').notNullable().defaultTo('{}')
      table.uuid('calendar_id').notNullable().references('id').inTable('calendars')
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
