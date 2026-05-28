export declare class SyncService {
    private lastSyncedAt;
    getLastSyncedAt(): Date | null;
    syncWithRedash(): Promise<{
        usersSynced: number;
        groupsSynced: number;
    }>;
    syncSingleUser(email: string): Promise<boolean>;
}
export declare const syncService: SyncService;
export default syncService;
