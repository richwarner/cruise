import { z } from "zod";

import { CITY_IDS } from "./types";

export const cityIdSchema = z.enum(CITY_IDS);

export const palletSchema = z
  .object({
    id: z.string().min(1).max(40),
    orderId: z.string().min(1).max(40),
    pickup: cityIdSchema,
    dropoff: cityIdSchema,
  })
  .refine((p) => p.pickup !== p.dropoff, {
    message: "Pallet pickup and dropoff must differ.",
    path: ["dropoff"],
  });

export const tripStopSchema = z.object({
  city: cityIdSchema,
  pickupPalletIds: z.array(z.string()),
  dropoffPalletIds: z.array(z.string()),
});

export const tripSchema = z.object({
  id: z.string().min(1).max(40),
  truckId: z.string().min(1).max(40),
  startMinutes: z.number().int().min(0).max(24 * 60),
  stops: z.array(tripStopSchema).min(1),
  palletIds: z.array(z.string()),
});

export const planSchema = z.object({
  trips: z.array(tripSchema),
  unassignedPalletIds: z.array(z.string()).default([]),
});

export const addOrderInputSchema = z.object({
  orderId: z.string().min(1).max(40),
  summary: z.string().min(1).max(240),
  pallets: z.array(palletSchema).min(1),
});

export const askPlannersInputSchema = z.object({
  orderId: z.string().min(1).max(40).optional(),
});

/**
 * Structured one-shot order entry. Used by the "Submit test order" debug
 * button and by Phase 5's director tool when the dispatcher types a natural
 * language order and the LLM parses it.
 */
export const submitOrderInputSchema = z
  .object({
    orderId: z.string().min(1).max(40),
    pickup: cityIdSchema,
    dropoff: cityIdSchema,
    pallets: z.number().int().min(1).max(30),
    summary: z.string().min(1).max(240).optional(),
  })
  .refine((o) => o.pickup !== o.dropoff, {
    message: "Order pickup and dropoff cities must differ.",
    path: ["dropoff"],
  });

export const submitPlanInputSchema = z.object({
  plan: planSchema,
  rationale: z
    .string()
    .max(500)
    .optional()
    .describe("One short paragraph explaining the plan shape."),
});

export const proposePlanInputSchema = z.object({
  seed: z.number().int().min(1).max(10),
  snapshot: z.any(),
  newOrder: z.any().optional(),
});

export const commitPlanInputSchema = z.object({
  plannerName: z.string().min(1),
});

export const resizeFleetInputSchema = z.object({
  size: z.number().int().min(1).max(50),
});
