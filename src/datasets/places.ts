/**
 * Where Chip's auction houses physically are. Stormwind, Ironforge and Booty Bay positions are the auctioneers
 * recorded by players in EG Link (Fitch, Lympkin, O'reely). Gadgetzan and Everlook are from the guide Chip pasted,
 * not yet recorded. uiMap ids are the game's map ids; x and y are 0 to 100 on that map.
 */
export interface Place { label: string; zone: string | null; uiMap: number | null; x: number | null; y: number | null }

export const AUCTION_HOUSES: Record<'alliance' | 'blackwater', Place[]> = {
  alliance: [
    { label: 'Stormwind auction house, Trade District', zone: 'Stormwind City', uiMap: 1453, x: 61.1, y: 71.2 },
    { label: 'Ironforge auction house, The Commons', zone: 'Ironforge', uiMap: 1455, x: 25.7, y: 75.3 },
  ],
  blackwater: [
    { label: 'Booty Bay auction house, lower docks', zone: 'Stranglethorn Vale', uiMap: 1434, x: 26.6, y: 76.4 },
    { label: 'Gadgetzan auction house', zone: 'Tanaris', uiMap: 1446, x: 52.0, y: 29.6 },
    { label: 'Everlook auction house', zone: 'Winterspring', uiMap: 1452, x: 61.4, y: 37.2 },
  ],
};
