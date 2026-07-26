import { randomInt } from 'crypto';
import prisma from '../config/prisma';
import config from '../config/config';
import keycloakAdminService, {
  isPrivilegedRealmRole,
} from './keycloak-admin.service';
import slackService, { type SlackDeliveryResult } from './slack.service';
import notificationSettingsService from './notification-settings.service';
import logger from '../utils/logger';
import {
  AuthorizationError,
  ConflictError,
  ExternalServiceError,
  NotFoundError,
} from '../utils/errors';

/**
 * Provisioning of **Apollo logins** — Keycloak realm users who can sign in to the
 * admin panel itself.
 *
 * Deliberately separate from `user-creation.service.ts`, which despite the
 * similar name does something else entirely: that one creates accounts on
 * *downstream platforms* (Redash, AWS Identity Center, ZooKeeper) for people who
 * already have an Apollo login. This service creates the Apollo login itself, and
 * is the only place in the codebase that mints a Keycloak user.
 *
 * Flow: super admin submits an email → a random password is generated → the
 * Keycloak user is created with that password marked temporary (Keycloak then
 * forces a reset at first login) → the password is DM'd to the recipient on
 * Slack. If Slack can't deliver it, the password comes back to the caller once so
 * the super admin can hand it over out-of-band; it is never persisted.
 *
 * Scope note: this service creates *login* accounts only, never roles. Granting a
 * `hermes_*` tier has to go through Admin Management, which writes the DB mirror
 * that `utils/authz.ts` actually authorizes against — writing the Keycloak role
 * alone would leave a user whose JWT claims a tier that Hermes still denies. The
 * panel's own roles (`super_admin`, `quality_staff`, …) are Keycloak-only and are
 * managed in the Keycloak console.
 */

// Ambiguous glyphs (I/O/l/0/1) are excluded throughout: when Slack delivery
// fails the password is read off a screen and retyped by a human, and "was that
// an l or a 1" is a support ticket waiting to happen.
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*-_=+';

const PASSWORD_LENGTH = 20;
/** Guaranteed minimum from each class, so any realm password policy is satisfied. */
const PER_CLASS_MINIMUM = 3;

/**
 * Audit actions. These double as the persistence layer for this feature — there
 * is no dedicated table, so `APOLLO_USER_CREATED` rows are what mark an account
 * as "provisioned through Hermes", and `APOLLO_USER_PASSWORD_RESENT` rows carry
 * the resend cooldown.
 */
const AUDIT_CREATED = 'APOLLO_USER_CREATED';
const AUDIT_RESENT = 'APOLLO_USER_PASSWORD_RESENT';

/**
 * Matches the 60s cooldown the platform-account resend flow uses
 * (user-creation.service). Beyond rate-limiting, it stops a double-click putting
 * two passwords in flight with no way to tell which one is live.
 */
const RESEND_COOLDOWN_MS = 60 * 1000;

/** Uniformly random character from `set` (crypto-backed, no modulo bias). */
function pick(set: string): string {
  return set[randomInt(set.length)];
}

/**
 * Generate a temporary password that satisfies essentially any Keycloak password
 * policy: 20 characters with at least three each of upper, lower, digit and
 * symbol, drawn with `crypto.randomInt` and shuffled so the guaranteed
 * characters aren't sitting in predictable positions.
 */
export function generateTemporaryPassword(): string {
  const classes = [UPPER, LOWER, DIGITS, SYMBOLS];
  const chars: string[] = [];

  for (const set of classes) {
    for (let i = 0; i < PER_CLASS_MINIMUM; i++) {
      chars.push(pick(set));
    }
  }

  const all = classes.join('');
  while (chars.length < PASSWORD_LENGTH) {
    chars.push(pick(all));
  }

  // Fisher-Yates, crypto-backed.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join('');
}

/** "rishit" → "Rishit". Leaves already-capitalised input alone. */
function titleCase(part: string): string {
  return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
}

/**
 * Derive a `First_Last` username, matching the convention the realm already uses
 * (Hermes renders usernames by swapping underscores for spaces, so `Rishit_Goel`
 * displays as "Rishit Goel"). Falls back to the email local part when no name was
 * given: `rishit.goel@bachatt.app` → `Rishit_Goel`.
 */
export function deriveUsername(
  email: string,
  firstName?: string,
  lastName?: string,
): string {
  const nameParts = [firstName, lastName]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .flatMap(s => s.trim().split(/\s+/))
    .filter(Boolean)
    .map(titleCase);

  if (nameParts.length > 0) {
    return nameParts.join('_');
  }

  const localPart = email.split('@')[0] ?? email;
  const parts = localPart
    .split(/[._\-+]+/)
    .filter(Boolean)
    .map(titleCase);
  return parts.length > 0 ? parts.join('_') : localPart;
}

export interface CreateApolloUserInput {
  email: string;
  firstName?: string;
  lastName?: string;
}

export interface PerformerIdentity {
  id: string;
  username: string;
}

export interface CreateApolloUserResult {
  userId: string;
  username: string;
  email: string;
  slack: SlackDeliveryResult;
  /**
   * Returned ONLY when Slack delivery did not happen, so the super admin can hand
   * the password over manually. Never stored, never logged, never returned on the
   * happy path.
   */
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

export class ApolloUserService {
  /**
   * Pick a free username, starting from the derived `First_Last` and appending
   * `_2`, `_3`, … on collision. Bounded: after a handful of attempts we hand the
   * base name to Keycloak and let its 409 surface as a ConflictError, rather than
   * hammering the Admin API.
   */
  private async resolveUsername(
    email: string,
    firstName?: string,
    lastName?: string,
  ): Promise<string> {
    const base = deriveUsername(email, firstName, lastName);
    for (let suffix = 1; suffix <= 5; suffix++) {
      const candidate = suffix === 1 ? base : `${base}_${suffix}`;
      if (!(await keycloakAdminService.usernameExists(candidate))) {
        return candidate;
      }
    }
    return base;
  }

  /**
   * Create an Apollo (Keycloak) login for `input.email` and deliver its temporary
   * password over Slack DM.
   *
   * The account is created with NO realm roles — it can sign in and nothing more.
   * Roles are assigned afterwards: Hermes tiers through Admin Management (which
   * also writes the DB mirror that authorization actually reads), everything else
   * in the Keycloak console.
   *
   * Failure model, in order of what has already happened when each one fires:
   *  - Keycloak not live / email already taken → nothing was created, throws.
   *  - Slack delivery fails → the account exists and works; the password is
   *    returned in `temporaryPassword` for manual handover.
   */
  async createUser(
    performer: PerformerIdentity,
    input: CreateApolloUserInput,
  ): Promise<CreateApolloUserResult> {
    const email = input.email.trim().toLowerCase();

    if (!keycloakAdminService.isLive) {
      throw new ExternalServiceError(
        'Keycloak is in simulation mode, so no real login can be created. ' +
          'This action requires a live Keycloak connection.',
      );
    }

    // Pre-flight existence check. Keycloak would 409 anyway, but checking first
    // turns "409 Conflict" into a message naming the account that's in the way.
    const existingId = await keycloakAdminService.findUserIdByEmail(email);
    if (existingId) {
      throw new ConflictError(
        `A Keycloak user already exists for ${email}. Use that account instead of creating a second one.`,
      );
    }

    const username = await this.resolveUsername(
      email,
      input.firstName,
      input.lastName,
    );
    const temporaryPassword = generateTemporaryPassword();

    const userId = await keycloakAdminService.createUser({
      email,
      username,
      firstName: input.firstName?.trim() || undefined,
      lastName: input.lastName?.trim() || undefined,
      temporaryPassword,
    });

    logger.info(
      { userId, username, email, performer: performer.username },
      '🔑 Created Apollo (Keycloak) login',
    );

    // ── Credential delivery ──────────────────────────────────────────────────
    const slackAllowed = await notificationSettingsService.isEnabled(
      'apollo.credentials.issued',
      'slack',
    );
    const slack: SlackDeliveryResult = slackAllowed
      ? await slackService.sendDirectMessage(
          email,
          this.buildSlackMessage(username, temporaryPassword),
          // The message carries the password — keep it out of the log line the
          // simulation branch would otherwise emit.
          { redactInLogs: true },
        )
      : { delivered: false, simulated: false, reason: 'disabled_by_settings' };

    if (!slack.delivered) {
      logger.warn(
        { userId, email, reason: slack.reason, simulated: slack.simulated },
        'Apollo login created but the Slack DM was not delivered — password returned to the creating admin for manual handover',
      );
    }

    // ── Audit ────────────────────────────────────────────────────────────────
    // Records that an account was minted and how the credential travelled. The
    // password itself is deliberately absent.
    //
    // Best-effort ON PURPOSE. By this point the Keycloak account exists and the
    // password has already been DM'd — both irreversible. Letting a database blip
    // throw here would report "creation failed" for an account that is live and
    // whose credential is already in the recipient's Slack, and on the
    // Slack-failed path it would destroy the only copy of the password before it
    // could be shown. A missing audit row is the lesser loss, so it is logged
    // loudly and swallowed.
    try {
      await prisma.auditEntry.create({
        data: {
          action: AUDIT_CREATED,
          performerId: performer.id,
          performerName: performer.username,
          targetUserId: userId,
          targetUserName: username,
          details: {
            email,
            credentialDelivery: slack.delivered
              ? 'slack_dm'
              : slack.simulated
                ? 'not_sent_simulation'
                : `failed:${slack.reason ?? 'unknown'}`,
          },
        },
      });
    } catch (err: any) {
      logger.error(
        {
          userId,
          username,
          email,
          performer: performer.username,
          error: err.message,
        },
        'APOLLO_USER_CREATED audit row could not be written — the account WAS created; record this manually',
      );
    }

    return {
      userId,
      username,
      email,
      slack,
      // Only surfaced when the DM didn't land — otherwise the password never
      // leaves this process.
      ...(slack.delivered ? {} : { temporaryPassword }),
    };
  }

  /**
   * Mint a NEW temporary password for an existing Apollo login and re-deliver it
   * over Slack. The recovery path for "the account was created but the password
   * never reached them" — a failed DM, or a super admin who closed the reveal
   * dialog without saving it. The previous password stops working immediately.
   *
   * Two guards, because this endpoint can otherwise take over an account:
   *
   *  1. **Hermes must have created it.** Authorized against an APOLLO_USER_CREATED
   *     audit row for the target, so this can only recover accounts this flow
   *     provisioned — not arbitrary realm users. Without this a super admin could
   *     reset any Keycloak password, including accounts that outrank them.
   *  2. **The target must not hold a privileged Keycloak built-in.** Defence in
   *     depth for the case where a Hermes-created account was later promoted to
   *     realm `admin` directly in Keycloak: `hermes_super_admin` cannot be granted
   *     those roles, so it must not be able to seize an account holding one.
   */
  async regeneratePassword(
    performer: PerformerIdentity,
    rawEmail: string,
  ): Promise<RegeneratePasswordResult> {
    const email = rawEmail.trim().toLowerCase();

    if (!keycloakAdminService.isLive) {
      throw new ExternalServiceError(
        'Keycloak is in simulation mode, so no password can be reset. ' +
          'This action requires a live Keycloak connection.',
      );
    }

    const userId = await keycloakAdminService.findUserIdByEmail(email);
    if (!userId) {
      throw new NotFoundError(`No Keycloak user found for ${email}.`);
    }

    // Guard 1 — provenance.
    const createdEntry = await prisma.auditEntry.findFirst({
      where: { action: AUDIT_CREATED, targetUserId: userId },
      orderBy: { createdAt: 'desc' },
    });
    if (!createdEntry) {
      throw new AuthorizationError(
        `${email} was not created through Hermes, so its password cannot be regenerated here. ` +
          'Reset it from the Keycloak admin console instead.',
      );
    }

    // Guard 2 — never act on an account that outranks this flow.
    const heldRoles = await keycloakAdminService.getUserRealmRoles(userId);
    const privileged = heldRoles.filter(isPrivilegedRealmRole);
    if (privileged.length > 0) {
      logger.warn(
        { userId, email, privileged, performer: performer.username },
        'Refused Apollo password regeneration — target holds a privileged Keycloak role',
      );
      throw new AuthorizationError(
        `${email} holds a privileged Keycloak role (${privileged.join(', ')}) and cannot be reset from Hermes.`,
      );
    }

    // Cooldown — keyed on the last resend for this target.
    const lastResend = await prisma.auditEntry.findFirst({
      where: { action: AUDIT_RESENT, targetUserId: userId },
      orderBy: { createdAt: 'desc' },
    });
    if (
      lastResend &&
      Date.now() - lastResend.createdAt.getTime() < RESEND_COOLDOWN_MS
    ) {
      throw new ConflictError(
        'A new password was generated for this user less than a minute ago. Wait a moment before trying again.',
      );
    }

    const username = createdEntry.targetUserName ?? email;
    const temporaryPassword = generateTemporaryPassword();

    // Past this line the OLD password is dead, so nothing below may throw the
    // operation away — same reasoning as the create path.
    await keycloakAdminService.resetPassword(userId, temporaryPassword);

    logger.info(
      { userId, email, performer: performer.username },
      '🔑 Regenerated Apollo temporary password',
    );

    const slackAllowed = await notificationSettingsService.isEnabled(
      'apollo.credentials.resent',
      'slack',
    );
    const slack: SlackDeliveryResult = slackAllowed
      ? await slackService.sendDirectMessage(
          email,
          this.buildSlackMessage(username, temporaryPassword, true),
          { redactInLogs: true },
        )
      : { delivered: false, simulated: false, reason: 'disabled_by_settings' };

    if (!slack.delivered) {
      logger.warn(
        { userId, email, reason: slack.reason, simulated: slack.simulated },
        'Apollo password regenerated but the Slack DM was not delivered — password returned to the requesting admin for manual handover',
      );
    }

    // Best-effort for the same reason as the create path: the password has
    // already been changed and sent, so a database blip must not report failure
    // for work that actually happened — or destroy the only copy of the password
    // before the UI can show it.
    try {
      await prisma.auditEntry.create({
        data: {
          action: AUDIT_RESENT,
          performerId: performer.id,
          performerName: performer.username,
          targetUserId: userId,
          targetUserName: username,
          details: {
            email,
            credentialDelivery: slack.delivered
              ? 'slack_dm'
              : slack.simulated
                ? 'not_sent_simulation'
                : `failed:${slack.reason ?? 'unknown'}`,
          },
        },
      });
    } catch (err: any) {
      logger.error(
        { userId, email, performer: performer.username, error: err.message },
        'APOLLO_USER_PASSWORD_RESENT audit row could not be written — the password WAS reset; record this manually',
      );
    }

    return {
      userId,
      username,
      email,
      slack,
      ...(slack.delivered ? {} : { temporaryPassword }),
    };
  }

  /**
   * The DM the user receives. Plain text: Slack renders `code` spans in DMs.
   * `isReset` distinguishes a fresh account from a regenerated password — the
   * latter must say the previous one is dead, or someone holding both will keep
   * trying the old one and think the account is broken.
   */
  private buildSlackMessage(
    username: string,
    password: string,
    isReset = false,
  ): string {
    return [
      isReset
        ? '🔑 *A new temporary password has been issued for your Apollo admin-panel account.*'
        : '👋 *An Apollo admin-panel account has been created for you.*',
      '',
      `• *Sign in:* ${config.frontend.url}`,
      `• *Username:* \`${username}\``,
      `• *Temporary password:* \`${password}\``,
      '',
      ...(isReset
        ? [
            'Any password you were sent previously has stopped working — use this one.',
          ]
        : []),
      'You will be asked to choose a new password the first time you sign in — this one stops working at that point.',
      'If you did not expect this message, please tell the Bachatt infra team before signing in.',
    ].join('\n');
  }
}

export const apolloUserService = new ApolloUserService();
export default apolloUserService;
