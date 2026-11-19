import { money } from '../format/money.ts';
import type { Leg } from './types.ts';

const legText = (l: Leg) => l.kind === 'any_vendor' ? 'any vendor' : l.kind === 'held' ? 'what you hold' : l.kind === 'vendor' ? `${l.who}${l.places[0]?.zone ? ` (${l.places[0].zone})` : ''}` : l.who;

/** One compact line, used for Discord and as the play's plain text: item, profit each, buy, sell, sales a day. */
export function playLine(name: string, perItem: number, buy: Leg, sell: Leg, salesPerDay: number | null): string {
  return `${name}: +${money(perItem)} each. Buy ${legText(buy)} ${money(buy.price)}, sell ${legText(sell)} ${money(sell.price)}` +
    (salesPerDay != null ? `, about ${Math.round(salesPerDay)} sell a day.` : '.');
}
