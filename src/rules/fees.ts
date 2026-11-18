/**
 * PROTECTED. Auction house fees. Changes here change every profit number in the tool,
 * so the overnight loop may propose but never auto merge edits to this folder.
 *
 * Cut: 5 percent Alliance, 15 percent Blackwater, verified from Chip's own sales (V18).
 * Deposit: NOT verified (test T7). Working assumption per spec decision 4: a share of the
 * vendor sell price per unit for a mid length listing, 1 copper minimum, five times at Blackwater.
 * The 15 percent rate is a conservative guess at the Classic mid duration rate. Every play that uses
 * a deposit says the deposit is assumed until T7 passes. Deposits on cheap items are tiny either way.
 */
export type Faction = 'alliance' | 'horde' | 'blackwater';

export const CUT: Record<Faction, number> = { alliance: 0.05, horde: 0.05, blackwater: 0.15 };
export const cutFor = (f: Faction) => CUT[f];

export const DEPOSIT = {
  /** share of vendor sell price per unit, assumed mid duration listing */
  rateOfSellPrice: 0.15,
  blackwaterMultiplier: 5,
  minimumCopper: 1,
  /** players report a 1 silver minimum listing price, conservative assumption until T7 */
  minimumListingPrice: 100,
  verified: false,
} as const;

/** Deposit in copper for listing `qty` units of an item with this vendor sell price. Lost if unsold. */
export function deposit(faction: Faction, sellPrice: number | null | undefined, qty = 1): number {
  const base = Math.floor((sellPrice ?? 0) * qty * DEPOSIT.rateOfSellPrice);
  const mult = faction === 'blackwater' ? DEPOSIT.blackwaterMultiplier : 1;
  return Math.max(DEPOSIT.minimumCopper, base) * mult;
}

/** What lands in Chip's mailbox per unit when an item sells at `price` on this house, after cut and deposit. */
export function netPerUnit(faction: Faction, price: number, sellPrice: number | null | undefined): number {
  return Math.floor(price * (1 - CUT[faction])) - deposit(faction, sellPrice, 1);
}

/**
 * Lowest selling price on `faction` that breaks even against a cost per unit.
 * Blackwater needs about 17.6 percent above cost (1 / 0.85), Alliance about 5.3 percent.
 */
export function breakEvenPrice(faction: Faction, cost: number, sellPrice: number | null | undefined): number {
  return Math.ceil((cost + deposit(faction, sellPrice, 1)) / (1 - CUT[faction]));
}
