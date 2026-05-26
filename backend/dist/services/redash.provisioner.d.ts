import { PlatformAdapter, ProvisionContext, ProvisionResult, DeprovisionContext, PlatformUserStatus } from './provisioner.interface';
export declare class RedashProvisioner implements PlatformAdapter {
    readonly platform = "redash";
    provision(ctx: ProvisionContext): Promise<ProvisionResult>;
    deprovision(ctx: DeprovisionContext): Promise<void>;
    checkUserStatus(email: string): Promise<PlatformUserStatus>;
    inviteUser(email: string, name: string): Promise<ProvisionResult>;
    healthCheck(): Promise<{
        healthy: boolean;
        message?: string;
    }>;
}
export declare const redashProvisioner: RedashProvisioner;
export default redashProvisioner;
