/**
 * Arranca el poller del debouncer de mensajes. Corre con la app
 * y los tiempos de limpieza viven en el servicio.
 */
import logger from '@adonisjs/core/services/logger'
import { conversationIdFromPhone, customerIdFromPhone } from '#services/agent_ids'
import { agentOrchestrator } from '#services/agent_orchestrator_service'
import { messageDebouncer } from '#services/message_debouncer_service'
import { inactivityTracker } from '#services/inactivity_tracker_service'

messageDebouncer.setFlushHandler((consolidated) => agentOrchestrator.handle(consolidated))
inactivityTracker.setLapseHandler((event) => {
  const customerId = customerIdFromPhone(event.phone)
  const conversationId = conversationIdFromPhone(event.phone)
  // TODO(leaf): acción real por lapso (mensaje de reenganche, etc.)
  logger.info(
    { ...event, customerId, conversationId },
    'Handler de lapso de inactividad (placeholder)'
  )
})

messageDebouncer.startPoller()
inactivityTracker.startPoller()
