import { z } from 'zod';

/**
 * Data contracts for every Blizzard payload we read.
 * Ledger rule 1: never infer a shape from a name. Each field here was seen in a
 * real response (see docs/verification-ledger, V2 to V17) before it was written down.
 * Fields we do not read are allowed through untouched.
 */

const ItemRef = z.object({ id: z.number().int().positive() }).passthrough();
const TimeLeft = z.enum(['SHORT', 'MEDIUM', 'LONG', 'VERY_LONG']);

/** Equipment and other non stackables. Always quantity 1 in Forever (V13). Bid only listings have no buyout. */
export const AuctionRow = z.object({
  id: z.number().int(),
  item: ItemRef,
  buyout: z.number().int().nonnegative().optional(),
  bid: z.number().int().nonnegative().optional(),
  quantity: z.number().int().positive(),
  time_left: TimeLeft,
}).passthrough();

/** Stackables, under the commodities endpoint, keyed `auctions` (V3), priced per unit (V4). */
export const CommodityRow = z.object({
  id: z.number().int(),
  item: ItemRef,
  quantity: z.number().int().positive(),
  unit_price: z.number().int().nonnegative(),
  time_left: TimeLeft,
}).passthrough();

export const HouseResponse = z.object({
  id: z.number().int(),
  auctions: z.array(AuctionRow).optional(),
  /** A link object, never an array (ledger failure 2). */
  commodities: z.object({ href: z.string().url() }).optional(),
}).passthrough();

/**
 * A dead house (112, V12) answers 200 with no `auctions` key at all (seen live November 19). Missing is read as
 * zero listings, which the collector flags as a suspected bug rather than a market fact (ledger rule 2).
 */
export const CommoditiesResponse = z.object({
  auctions: z.array(CommodityRow).optional().default([]),
}).passthrough();

export const HouseIndex = z.object({
  auctions: z.array(z.object({ id: z.number().int(), name: z.string() }).passthrough()),
}).passthrough();

export const ItemResponse = z.object({
  id: z.number().int(),
  name: z.string(),
  quality: z.object({ type: z.string() }).passthrough().optional(),
  level: z.number().int().optional(),
  required_level: z.number().int().optional(),
  item_class: z.object({ id: z.number().int(), name: z.string() }).passthrough().optional(),
  item_subclass: z.object({ id: z.number().int(), name: z.string() }).passthrough().optional(),
  inventory_type: z.object({ type: z.string() }).passthrough().optional(),
  binding: z.object({ type: z.string() }).passthrough().optional(),
  purchase_price: z.number().int().nonnegative().optional(),
  purchase_quantity: z.number().int().optional(),
  sell_price: z.number().int().nonnegative().optional(),
  max_count: z.number().int().optional(),
  is_equippable: z.boolean().optional(),
  is_stackable: z.boolean().optional(),
  media: z.object({ id: z.number().int() }).passthrough().optional(),
}).passthrough();

export const MediaResponse = z.object({
  assets: z.array(z.object({ key: z.string(), value: z.string().url() }).passthrough()).optional(),
}).passthrough();

const NamedRef = z.object({ id: z.number().int(), name: z.string() }).passthrough();

export const ProfessionIndex = z.object({ professions: z.array(NamedRef) }).passthrough();
export const Profession = z.object({ id: z.number().int(), name: z.string(), skill_tiers: z.array(NamedRef).optional() }).passthrough();
export const SkillTier = z.object({
  id: z.number().int(),
  categories: z.array(z.object({ name: z.string(), recipes: z.array(NamedRef).optional() }).passthrough()).optional(),
}).passthrough();
export const Recipe = z.object({
  id: z.number().int(),
  name: z.string(),
  crafted_item: NamedRef.optional(),
  alliance_crafted_item: NamedRef.optional(),
  horde_crafted_item: NamedRef.optional(),
  crafted_quantity: z.object({ value: z.number().optional(), minimum: z.number().optional(), maximum: z.number().optional() }).passthrough().optional(),
  reagents: z.array(z.object({ reagent: NamedRef, quantity: z.number().int().positive() }).passthrough()).optional(),
}).passthrough();

export type AuctionRow = z.infer<typeof AuctionRow>;
export type CommodityRow = z.infer<typeof CommodityRow>;
export type ItemResponse = z.infer<typeof ItemResponse>;
export type RecipeResponse = z.infer<typeof Recipe>;
