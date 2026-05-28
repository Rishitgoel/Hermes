export interface RedashUserResponse {
    id: number;
    name: string;
    email: string;
    is_disabled: boolean;
    is_invitation_pending: boolean;
    groups: number[];
}
export interface RedashGroupResponse {
    id: number;
    name: string;
    type: string;
}
export declare class RedashService {
    private baseUrl;
    private apiKey;
    private isSimulation;
    constructor();
    private getClient;
    syncUsers(): Promise<RedashUserResponse[]>;
    fetchUserByEmail(email: string): Promise<RedashUserResponse | null>;
    syncGroups(): Promise<RedashGroupResponse[]>;
    /**
     * Result of `findOrInviteUser`:
     *  - `id` is the Redash user ID, populated either way.
     *  - `inviteLink` is the Redash-issued one-time setup URL, present ONLY when
     *    we just created a fresh invited user. Returns undefined when the user
     *    already existed (no setup needed).
     */
    findOrInviteUser(email: string, name: string): Promise<{
        id: number;
        inviteLink?: string;
    }>;
    addUserToGroup(redashUserId: number, redashGroupId: number): Promise<void>;
    removeUserFromGroup(redashUserId: number, redashGroupId: number): Promise<void>;
}
export declare const redashService: RedashService;
export default redashService;
