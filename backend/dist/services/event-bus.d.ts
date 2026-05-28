import { EventEmitter } from 'events';
export interface AccessEvent {
    type: 'request.created' | 'request.approved' | 'request.rejected' | 'access.granted' | 'access.revoked' | 'access.expired' | 'access.queued-for-setup' | 'provision.failed' | 'sync.triggered' | 'user-creation.submitted' | 'user-creation.invited' | 'user-creation.rejected' | 'user-creation.completed';
    payload: Record<string, unknown>;
    timestamp: Date;
}
declare class HermesEventBus extends EventEmitter {
    emitAccessEvent(event: AccessEvent): void;
}
export declare const eventBus: HermesEventBus;
export default eventBus;
