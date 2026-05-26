import { EventEmitter } from 'events';
export interface AccessEvent {
    type: 'request.created' | 'request.approved' | 'request.rejected' | 'access.granted' | 'access.revoked' | 'access.expired' | 'provision.failed' | 'sync.triggered';
    payload: Record<string, unknown>;
    timestamp: Date;
}
declare class AtlasEventBus extends EventEmitter {
    emitAccessEvent(event: AccessEvent): void;
}
export declare const eventBus: AtlasEventBus;
export default eventBus;
