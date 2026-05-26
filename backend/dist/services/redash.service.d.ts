export interface RedashUserResponse {
    id: number;
    name: string;
    email: string;
    is_disabled: boolean;
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
    syncGroups(): Promise<RedashGroupResponse[]>;
    findOrInviteUser(email: string, name: string): Promise<number>;
    addUserToGroup(redashUserId: number, redashGroupId: number): Promise<void>;
    removeUserFromGroup(redashUserId: number, redashGroupId: number): Promise<void>;
}
export declare const redashService: RedashService;
export default redashService;
