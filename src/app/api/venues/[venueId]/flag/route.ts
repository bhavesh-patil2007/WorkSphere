import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rateLimit";
import { apiError } from "@/lib/apiResponse";
import { apiHandler } from "@/lib/apiHandler";
import { invalidateVenueReviewsCache } from "@/lib/cache/swrCache";
import { emitWebhookEvent } from "@/lib/notifications/channels/webhookChannel";

const VALID_REASONS = [
  "permanently_closed",
  "wrong_hours",
  "no_wifi",
  "wrong_address",
  "duplicate",
  "other",
] as const;

type FlagReason = (typeof VALID_REASONS)[number];

const MIN_REASON_NON_WHITESPACE_LENGTH = 5;

const flagVenueSchema = z.object({
  reason: z
    .string({
      error: "Reason must contain at least 5 non-whitespace characters",
    })
    .trim()
    .refine(
      (val) =>
        val.replace(/\s+/g, "").length >= MIN_REASON_NON_WHITESPACE_LENGTH,
      {
        message: "Reason must contain at least 5 non-whitespace characters",
      },
    )
    .refine(
      (val): val is FlagReason =>
        (VALID_REASONS as readonly string[]).includes(val),
      {
        message: `Invalid reason. Must be one of: ${VALID_REASONS.join(", ")}`,
      },
    ),
  details: z.string().trim().optional(),
});

interface FlagVenueBody {
  reason: FlagReason;
  details?: string;
}

export const POST = apiHandler<FlagVenueBody, { venueId: string }>({
  authRequired: true,
  schema: flagVenueSchema,
  handler: async ({ body, params, userId }) => {
    // Rate limit: 5 flag reports per user per hour
    const limited = await rateLimit(`venue-flag:${userId}`, 5, 3_600_000);
    if (!limited) {
      return apiError(
        "Too many reports. Please try again later.",
        429,
        "RATE_LIMITED",
      );
    }

    const { venueId } = params;
    const reason = body.reason.trim() as FlagReason;
    const details = body.details?.trim();

    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true },
    });
    if (!venue) {
      return apiError("Venue not found", 404, "VENUE_NOT_FOUND");
    }

    // Prevent duplicate flags from the same user for the same venue + reason
    const existing = await prisma.flaggedItem.findFirst({
      where: {
        itemId: venueId,
        reportedById: userId!,
        reason,
        status: "PENDING",
      },
    });
    if (existing) {
      return NextResponse.json(
        { message: "You have already reported this issue." },
        { status: 200 },
      );
    }

    const flag = await prisma.flaggedItem.create({
      data: {
        type: "VENUE",
        itemId: venueId,
        reason,
        reportedById: userId!,
        ...(details ? { details } : {}),
      } as Parameters<typeof prisma.flaggedItem.create>[0]["data"],
      select: { id: true },
    });

    // Notify configured webhook endpoints owned by moderators only. Delivery is
    // scheduled by emitWebhookEvent and must not make flag submission fail.
    try {
      const moderators = await prisma.user.findMany({
        where: { isAdmin: true },
        select: { id: true },
      });
      for (const moderator of moderators) {
        emitWebhookEvent(moderator.id, "VENUE_FLAGGED", {
          flagId: flag.id,
          venueId,
          reason,
          details: details ?? null,
          reportedById: userId!,
        });
      }
    } catch (notificationError) {
      console.error("[venue-flag] Failed to schedule moderator webhook:", notificationError);
    }

    await invalidateVenueReviewsCache(venueId);

    return NextResponse.json({
      message: "Report submitted. Thank you for your feedback!",
    });
  },
});
