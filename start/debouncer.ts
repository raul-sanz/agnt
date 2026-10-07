/**
 * Arranca el poller del debouncer de mensajes. Corre con la app
 * y los tiempos de limpieza viven en el servicio.
 */
import { agentOrchestrator } from '#services/agent_orchestrator_service'
import { messageDebouncer } from '#services/message_debouncer_service'

messageDebouncer.setFlushHandler((consolidated) => agentOrchestrator.handle(consolidated))

messageDebouncer.startPoller()
