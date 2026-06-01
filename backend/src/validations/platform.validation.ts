import { z } from 'zod';

// User-facing allowlist for nice 400s on group creation. The runtime source of
// truth for what can actually be provisioned is the provisioning registry —
// this enum is just a friendly guard at the API boundary.
// TODO(aws): add 'aws' here when the AwsProvisioner adapter is registered.
export const PlatformEnum = z.enum(['redash'], {
  errorMap: () => ({ message: 'Unsupported platform. Currently supported: redash' }),
});

export type Platform = z.infer<typeof PlatformEnum>;
