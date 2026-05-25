export declare class SyncService {
    syncWithRedash(): Promise<{
        usersSynced: number;
        groupsSynced: number;
    }>;
}
export declare const syncService: SyncService;
export default syncService;
