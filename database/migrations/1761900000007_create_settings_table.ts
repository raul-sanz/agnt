import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'settings'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table.jsonb('phone_data').notNullable().defaultTo('{}')
      table.jsonb('agent_config').notNullable().defaultTo('{}')
      table.jsonb('services').notNullable().defaultTo('{}')
      table.jsonb('patient_fields').notNullable().defaultTo('[]')
      table.jsonb('clinic_info').notNullable().defaultTo('{}')
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
