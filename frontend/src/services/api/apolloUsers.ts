import apiClient from '../apiClient';

/**
 * Apollo login provisioning — creates the Keycloak user that lets someone sign in
 * to the admin panel at all. Super-admin only, enforced server-side.
 *
 * Not to be confused with `userCreation.ts`, which requests an account on a
 * downstream *platform* (Redash / AWS / ZooKeeper) for someone who already has an
 * Apollo login. apiClient unwraps the response envelope, so each call resolves to
 * the payload.
 */

export interface CreateApolloUserInput {
  email: string;
  firstName?: string;
  lastName?: string;
}

export interface SlackDeliveryResult {
  delivered: boolean;
  simulated: boolean;
  reason?: string;
}

export interface CreateApolloUserResult {
  userId: string;
  username: string;
  email: string;
  slack: SlackDeliveryResult;
  /** Present ONLY when the Slack DM didn't land — hand over manually, shown once. */
  temporaryPassword?: string;
}

export interface RegeneratePasswordResult {
  userId: string;
  username: string;
  email: string;
  slack: SlackDeliveryResult;
  /** Present ONLY when the Slack DM didn't land — hand over manually, shown once. */
  temporaryPassword?: string;
}

export async function createApolloUser(
  body: CreateApolloUserInput,
): Promise<CreateApolloUserResult> {
  const res = await apiClient.post('/api/apollo-users', body);
  return res.data as CreateApolloUserResult;
}

/**
 * Mint a fresh temporary password for an existing Apollo login and re-send it.
 * Server-side this is scoped to accounts Hermes created, so it can't be used to
 * reset an arbitrary Keycloak user.
 */
export async function resendApolloPassword(
  email: string,
): Promise<RegeneratePasswordResult> {
  const res = await apiClient.post('/api/apollo-users/resend-password', { email });
  return res.data as RegeneratePasswordResult;
}
