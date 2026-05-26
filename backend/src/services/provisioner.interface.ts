export interface ProvisionContext {
  email: string;
  name: string;
  externalGroupId?: string;
  metadata?: Record<string, unknown>;  // For platform-specific data (ARNs, project keys, etc.)
}

export interface ProvisionResult {
  externalUserId: string;
  metadata?: Record<string, unknown>;
}

export interface DeprovisionContext {
  externalUserId: string;
  externalGroupId?: string;
  metadata?: Record<string, unknown>;
}

export interface PlatformUserStatus {
  exists: boolean;
  externalUserId?: string;
  email: string;
  metadata?: Record<string, unknown>;
}

export interface PlatformAdapter {
  readonly platform: string;

  provision(ctx: ProvisionContext): Promise<ProvisionResult>;
  deprovision(ctx: DeprovisionContext): Promise<void>;

  checkUserStatus(email: string): Promise<PlatformUserStatus>;
  inviteUser(email: string, name: string): Promise<ProvisionResult>;

  syncUsers?(): Promise<{ count: number }>;
  syncGroups?(): Promise<{ count: number }>;

  healthCheck(): Promise<{ healthy: boolean; message?: string }>;
}

// Keep backward-compat alias
export type Provisioner = PlatformAdapter;
