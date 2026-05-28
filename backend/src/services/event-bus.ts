import { EventEmitter } from 'events';
import logger from '../utils/logger';

export interface AccessEvent {
  type: 'request.created' | 'request.approved' | 'request.rejected' | 'access.granted' | 'access.revoked' | 'access.expired' | 'provision.failed' | 'sync.triggered';
  payload: Record<string, unknown>;
  timestamp: Date;
}

class HermesEventBus extends EventEmitter {
  emitAccessEvent(event: AccessEvent): void {
    logger.debug({ event: event.type }, `Event emitted: ${event.type}`);
    this.emit(event.type, event);
    this.emit('*', event); // Wildcard listener for audit/logging
  }
}

export const eventBus = new HermesEventBus();
export default eventBus;
