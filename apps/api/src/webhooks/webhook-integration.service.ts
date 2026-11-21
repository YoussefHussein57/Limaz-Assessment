import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import {
  decodeEncryptionKey,
  generateDeliveryId,
  generateSigningSecret,
  openSecret,
  sealSecret,
  type SealedSecret,
} from './webhook-crypto';

/**
 * What an administrator may see about a company's integration.
 *
 * No ciphertext, no IV, no tag and no plaintext. An encrypted secret is not
 * directly usable, but publishing it hands an attacker everything except the
 * key - and no management operation needs it, which is the test every field
 * in this codebase has to pass.
 */
export interface WebhookIntegrationSummary {
  readonly configured: true;
  /** Public. It selects a secret; it proves nothing. */
  readonly deliveryId: string;
  /** How many times the signing secret has been replaced. */
  readonly secretVersion: number;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
}

export type WebhookIntegrationState = WebhookIntegrationSummary | { readonly configured: false };

/** The one shape that ever carries a signing secret. Returned exactly once. */
export interface ProvisionedWebhookIntegration {
  readonly integration: WebhookIntegrationSummary;
  /**
   * The HMAC signing secret, shown once.
   *
   * Unlike an API key this one COULD be recovered - it is encrypted, not
   * hashed, so the server can still decrypt it. It is deliberately not
   * exposed anyway: an endpoint that returns it on demand would turn one
   * compromised administrator session into every company's signing key, and
   * the whole reason the key lives outside the database is to need two
   * things to go wrong rather than one.
   */
  readonly signingSecret: string;
}

/**
 * Provisioning and reading a company's card webhook integration (F12).
 *
 * The company id is a PATH SELECTOR here exactly as it is everywhere else in
 * the admin module: the caller has already been established as a platform
 * administrator by the guard, and this names which company to act on.
 */
@Injectable()
export class WebhookIntegrationService {
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) env: Env,
  ) {
    // Decoded once, at construction. A per-request decode would turn a
    // configuration error into a request error, hours after the deployment
    // that caused it.
    this.encryptionKey = decodeEncryptionKey(env.WEBHOOK_ENCRYPTION_KEY);
  }

  /** Metadata only. Never a secret, in any form. */
  async describe(companyId: string): Promise<WebhookIntegrationState> {
    await this.requireCompany(companyId);

    const row = await this.prisma.webhookIntegration.findUnique({
      where: { companyId },
      select: { deliveryId: true, secretVersion: true, createdAt: true, rotatedAt: true },
    });

    if (!row) {
      return { configured: false };
    }

    return {
      configured: true,
      deliveryId: row.deliveryId,
      secretVersion: row.secretVersion,
      createdAt: row.createdAt.toISOString(),
      rotatedAt: row.rotatedAt?.toISOString() ?? null,
    };
  }

  /**
   * Creates the integration, or replaces its signing secret.
   *
   * ---------------------------------------------------------------------
   * WHY REPLACEMENT HAS NO GRACE WINDOW, UNLIKE API KEY ROTATION
   * ---------------------------------------------------------------------
   *
   * An API key rotation keeps the old key alive for 24 hours because the
   * company cannot deploy a new one to all of its servers atomically, and
   * without the window every rotation would be an outage.
   *
   * A webhook signing secret is configured in ONE place - the provider's
   * dashboard - and the provider retries until it gets a 2xx. So a delivery
   * signed with the old secret during the changeover is refused, the provider
   * retries, and by then the new secret is in place. The event is not lost;
   * it is delayed. Two valid secrets at once would instead mean a leaked
   * secret stays valid for a day after somebody replaced it because it
   * leaked, which is the opposite of what replacement is for.
   *
   * The `deliveryId` is KEPT across a replacement. It is not a secret, the
   * provider is already configured with it, and changing it would turn a
   * secret rotation into a full re-integration.
   */
  async provision(companyId: string): Promise<ProvisionedWebhookIntegration> {
    await this.requireCompany(companyId);

    const signingSecret = generateSigningSecret();
    const sealed = sealSecret(signingSecret, this.encryptionKey, companyId);
    const existing = await this.prisma.webhookIntegration.findUnique({
      where: { companyId },
      select: { id: true, secretVersion: true },
    });

    const row = existing
      ? await this.prisma.webhookIntegration.update({
          where: { companyId },
          data: {
            // `new Uint8Array` at the Prisma boundary: a Prisma `Bytes`
            // column is typed `Uint8Array<ArrayBuffer>`, and a Node `Buffer`
            // is `Buffer<ArrayBufferLike>` - which includes SharedArrayBuffer
            // and so is not assignable. The copy is a few dozen bytes.
            secretCiphertext: new Uint8Array(sealed.ciphertext),
            secretIv: new Uint8Array(sealed.iv),
            secretAuthTag: new Uint8Array(sealed.authTag),
            secretVersion: existing.secretVersion + 1,
            rotatedAt: new Date(),
          },
        })
      : await this.prisma.webhookIntegration.create({
          data: {
            companyId,
            deliveryId: generateDeliveryId(),
            secretCiphertext: new Uint8Array(sealed.ciphertext),
            secretIv: new Uint8Array(sealed.iv),
            secretAuthTag: new Uint8Array(sealed.authTag),
          },
        });

    return {
      integration: {
        configured: true,
        deliveryId: row.deliveryId,
        secretVersion: row.secretVersion,
        createdAt: row.createdAt.toISOString(),
        rotatedAt: row.rotatedAt?.toISOString() ?? null,
      },
      signingSecret,
    };
  }

  /**
   * Resolves a delivery id to the company and its signing secret.
   *
   * INTERNAL ONLY. Nothing that returns a plaintext secret may be reachable
   * from a route; this exists so the intake verifier and the sandbox
   * simulator can both sign and verify server-side, inside the process.
   *
   * Returns null for an unknown delivery id. The caller must still do the
   * HMAC work in that case - see `WebhookIntakeService` - or the response
   * time alone would say whether a delivery id exists.
   */
  async resolveSecret(
    deliveryId: string,
  ): Promise<{ companyId: string; signingSecret: string } | null> {
    const row = await this.prisma.webhookIntegration.findUnique({
      where: { deliveryId },
      select: {
        companyId: true,
        secretCiphertext: true,
        secretIv: true,
        secretAuthTag: true,
      },
    });

    if (!row) {
      return null;
    }

    const sealed: SealedSecret = {
      ciphertext: Buffer.from(row.secretCiphertext),
      iv: Buffer.from(row.secretIv),
      authTag: Buffer.from(row.secretAuthTag),
    };

    // The company id is the additional authenticated data, so this throws if
    // the row was moved between companies. That is the point of binding it.
    return {
      companyId: row.companyId,
      signingSecret: openSecret(sealed, this.encryptionKey, row.companyId),
    };
  }

  private async requireCompany(companyId: string): Promise<void> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true },
    });

    if (!company) {
      throw new NotFoundException({ error: 'not_found', message: 'No such company.' });
    }
  }
}
