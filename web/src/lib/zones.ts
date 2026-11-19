/**
 * Game map id (uiMap, what EG Link records) to zone name and the area id wowhead uses for its Classic zone maps.
 * Map images: wow.zamimg.com/images/wow/classic/maps/enus/original/<areaId>.jpg, 1022 x 668. Map coordinates
 * (0 to 100) line up with the image directly; checked with the Booty Bay auctioneer and Nerrist at Grom'gol.
 * New WoW Forever zones have no image yet and show their coordinates only.
 */
export const ZONES: Record<number, { name: string; area: number }> = {
  1411: { name: 'Durotar', area: 14 }, 1412: { name: 'Mulgore', area: 215 }, 1413: { name: 'The Barrens', area: 17 },
  1416: { name: 'Alterac Mountains', area: 36 }, 1417: { name: 'Arathi Highlands', area: 45 }, 1418: { name: 'Badlands', area: 3 },
  1419: { name: 'Blasted Lands', area: 4 }, 1420: { name: 'Tirisfal Glades', area: 85 }, 1421: { name: 'Silverpine Forest', area: 130 },
  1422: { name: 'Western Plaguelands', area: 28 }, 1423: { name: 'Eastern Plaguelands', area: 139 }, 1424: { name: 'Hillsbrad Foothills', area: 267 },
  1425: { name: 'The Hinterlands', area: 47 }, 1426: { name: 'Dun Morogh', area: 1 }, 1427: { name: 'Searing Gorge', area: 51 },
  1428: { name: 'Burning Steppes', area: 46 }, 1429: { name: 'Elwynn Forest', area: 12 }, 1430: { name: 'Deadwind Pass', area: 41 },
  1431: { name: 'Duskwood', area: 10 }, 1432: { name: 'Loch Modan', area: 38 }, 1433: { name: 'Redridge Mountains', area: 44 },
  1434: { name: 'Stranglethorn Vale', area: 33 }, 1435: { name: 'Swamp of Sorrows', area: 8 }, 1436: { name: 'Westfall', area: 40 },
  1437: { name: 'Wetlands', area: 11 }, 1438: { name: 'Teldrassil', area: 141 }, 1439: { name: 'Darkshore', area: 148 },
  1440: { name: 'Ashenvale', area: 331 }, 1441: { name: 'Thousand Needles', area: 400 }, 1442: { name: 'Stonetalon Mountains', area: 406 },
  1443: { name: 'Desolace', area: 405 }, 1444: { name: 'Feralas', area: 357 }, 1445: { name: 'Dustwallow Marsh', area: 15 },
  1446: { name: 'Tanaris', area: 440 }, 1447: { name: 'Azshara', area: 16 }, 1448: { name: 'Felwood', area: 361 },
  1449: { name: "Un'Goro Crater", area: 490 }, 1450: { name: 'Moonglade', area: 493 }, 1451: { name: 'Silithus', area: 1377 },
  1452: { name: 'Winterspring', area: 618 }, 1453: { name: 'Stormwind City', area: 1519 }, 1454: { name: 'Orgrimmar', area: 1637 },
  1455: { name: 'Ironforge', area: 1537 }, 1456: { name: 'Thunder Bluff', area: 1638 }, 1457: { name: 'Darnassus', area: 1657 },
  1458: { name: 'Undercity', area: 1497 },
};
export const mapImage = (uiMap: number) => ZONES[uiMap] ? `https://wow.zamimg.com/images/wow/classic/maps/enus/original/${ZONES[uiMap]!.area}.jpg` : null;

export interface Place { label: string; zone: string | null; uiMap: number | null; x: number | null; y: number | null }

/** The map link for a place: #map/<uiMap>/<x>/<y>/<label> */
export const mapHref = (p: Place) => p.uiMap != null && p.x != null && p.y != null ? `#map/${p.uiMap}/${p.x}/${p.y}/${encodeURIComponent(p.label)}` : null;
