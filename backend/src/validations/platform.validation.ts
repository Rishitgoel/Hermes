import { z } from 'zod';
import provisioningRegistry from '../services/provisioning.registry';

// Platform validation, derived from the provisioning registry — the single runtime
// source of truth for what Hermes can actually provision. There is no hardcoded
// enum here, so registering a new adapter makes its key valid automatically (and
// the 400 message lists whatever is currently registered). Lowercases the input
// to match the registry's case-insensitive keys.
export const PlatformSchema = z
  .string()
  .trim()
  .min(1)
  .transform((p) => p.toLowerCase())
  .refine((p) => provisioningRegistry.has(p), (p) => ({
    message: `Unsupported platform "${p}". Supported: ${provisioningRegistry.listPlatforms().join(', ')}`,
  }));

export type Platform = z.infer<typeof PlatformSchema>;
