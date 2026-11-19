/** What Chip saw in game. Shared by match-house and compare-houses. Edit when you take new screenshots. */
// From Chip's Stormwind screenshots, November 19. Ladders are [price in copper, units at that price].
export const SEEN = {
  items: [
    { id: 2770, name: 'Copper Ore', floor: 95, units: 12508 },
    { id: 2589, name: 'Linen Cloth', floor: 27, units: 16252 },
    { id: 2840, name: 'Copper Bar', floor: 105, units: 8738 },
  ],
  ladders: {
    2770: [[95, 182], [96, 73], [97, 323], [98, 101], [99, 66], [100, 1112], [101, 12], [102, 352], [103, 142], [104, 32], [105, 1230],
      [106, 154], [107, 69], [108, 294], [109, 452], [110, 1100], [118, 460], [119, 352], [120, 39]],
    2589: [[27, 50], [28, 1105], [29, 5360], [30, 3542], [31, 254], [32, 66], [33, 175], [34, 212], [35, 214], [36, 61], [37, 95],
      [39, 26], [40, 251], [41, 12], [44, 174], [45, 60], [46, 40], [48, 86], [49, 20]],
    2840: [[105, 346], [106, 212], [107, 1261], [108, 451], [109, 72], [110, 921], [111, 117], [112, 424], [113, 651], [114, 94],
      [115, 222], [116, 56], [117, 280], [118, 913], [119, 60], [120, 875], [121, 20], [122, 34], [125, 452]],
  } as Record<number, Array<[number, number]>>,
};

