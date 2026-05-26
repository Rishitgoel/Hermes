import { PlatformAdapter } from './provisioner.interface';
declare class ProvisioningRegistry {
    private registry;
    constructor();
    register(platform: string, adapter: PlatformAdapter): void;
    get(platform: string): PlatformAdapter;
    has(platform: string): boolean;
    listPlatforms(): string[];
    healthCheckAll(): Promise<Record<string, {
        healthy: boolean;
        message?: string;
    }>>;
}
export declare const provisioningRegistry: ProvisioningRegistry;
export default provisioningRegistry;
