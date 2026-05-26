import { PlatformAdapter, ProvisionContext, ProvisionResult, DeprovisionContext, PlatformUserStatus } from './provisioner.interface';
import redashService from './redash.service';
import prisma from '../config/prisma';

export class RedashProvisioner implements PlatformAdapter {
  readonly platform = 'redash';

  async provision(ctx: ProvisionContext): Promise<ProvisionResult> {
    const redashUserId = await redashService.findOrInviteUser(ctx.email, ctx.name);
    if (ctx.externalGroupId) {
      await redashService.addUserToGroup(redashUserId, parseInt(ctx.externalGroupId, 10));
    }
    return { externalUserId: redashUserId.toString() };
  }

  async deprovision(ctx: DeprovisionContext): Promise<void> {
    if (ctx.externalGroupId) {
      await redashService.removeUserFromGroup(
        parseInt(ctx.externalUserId, 10),
        parseInt(ctx.externalGroupId, 10)
      );
    }
  }

  async checkUserStatus(email: string): Promise<PlatformUserStatus> {
    const redashUser = await prisma.redashUser.findUnique({
      where: { email: email.toLowerCase() },
    });
    return {
      exists: !!redashUser,
      externalUserId: redashUser?.id?.toString(),
      email,
    };
  }

  async inviteUser(email: string, name: string): Promise<ProvisionResult> {
    const redashUserId = await redashService.findOrInviteUser(email, name);
    await prisma.redashUser.upsert({
      where: { email: email.toLowerCase() },
      update: {
        name,
        lastSyncedAt: new Date(),
      },
      create: {
        id: redashUserId,
        name,
        email: email.toLowerCase(),
        isDisabled: false,
        groupIds: [1],
        lastSyncedAt: new Date(),
      },
    });
    return { externalUserId: redashUserId.toString() };
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    try {
      await redashService.syncGroups(); // lightweight probe
      return { healthy: true };
    } catch (err: any) {
      return { healthy: false, message: err.message };
    }
  }
}

export const redashProvisioner = new RedashProvisioner();
export default redashProvisioner;
