/**
 * Blacksmithing 1 to 300, from the YouTube guide Chip shared on November 19, corrected against the game tables
 * (docs/blacksmithing-plan.md explains each correction). Recipes are matched to the database by name.
 * `alt` is a second route for the same skill range, compared at live prices.
 */
export interface GuideStep { from: number; to: number; recipe: string; alt?: string; note?: string }

/**
 * Where the guide says to get recipes that no Forever record covers yet. Unconfirmed until EG Link or Chip sees it.
 * Trainer taught recipes need nothing here: trainer_spells answers them.
 */
export const GUIDE_LEARN: Record<string, string> = {
  'Rough Sharpening Stone': 'Known as soon as you learn Blacksmithing',
  'Ebon Shiv': 'Plans from Magnus Frostwake, Caer Darrow (Western Plaguelands), per the guide',
  'Bold Dirk': 'New in Forever, needs Azerothium; source not recorded yet',
};

export const BLACKSMITHING: GuideStep[] = [
  { from: 1, to: 30, recipe: 'Rough Sharpening Stone' },
  { from: 30, to: 65, recipe: 'Rough Grinding Stone', note: 'Keep 6 for the Silver Skeleton Keys' },
  { from: 65, to: 75, recipe: 'Copper Chain Belt' },
  { from: 75, to: 80, recipe: 'Silver Skeleton Key', note: 'Each key also takes a Rough Grinding Stone' },
  { from: 80, to: 90, recipe: 'Rough Bronze Leggings' },
  { from: 90, to: 100, recipe: 'Runed Copper Belt' },
  { from: 100, to: 105, recipe: 'Heavy Sharpening Stone' },
  { from: 105, to: 110, recipe: 'Runed Copper Belt' },
  { from: 110, to: 125, recipe: 'Rough Bronze Leggings', note: 'Train Expert at 125 first if you are capped' },
  { from: 125, to: 129, recipe: 'Iron Buckle' },
  { from: 129, to: 140, recipe: 'Bronze Warhammer' },
  { from: 140, to: 147, recipe: 'Patterned Bronze Bracers', alt: 'Bronze Warhammer', note: 'Warhammers stay orange to 155; bracers are half way to grey here' },
  { from: 147, to: 155, recipe: 'Green Iron Bracers' },
  { from: 155, to: 165, recipe: 'Green Iron Leggings', note: '50s to learn' },
  { from: 165, to: 183, recipe: 'Green Iron Bracers' },
  { from: 183, to: 190, recipe: 'Heavy Mithril Gauntlet' },
  { from: 190, to: 200, recipe: 'Golden Scale Bracers', note: 'Train Artisan at 200, Brikk Keencraft in Booty Bay' },
  { from: 200, to: 205, recipe: 'Heavy Mithril Gauntlet' },
  { from: 205, to: 210, recipe: 'Heavy Mithril Pants' },
  { from: 210, to: 215, recipe: 'Heavy Mithril Gauntlet' },
  { from: 215, to: 225, recipe: 'Heavy Mithril Breastplate' },
  { from: 225, to: 235, recipe: 'Dense Weightstone' },
  { from: 235, to: 240, recipe: 'Mithril Coif' },
  { from: 240, to: 246, recipe: 'Heavy Mithril Boots' },
  { from: 246, to: 250, recipe: 'Big Black Mace' },
  { from: 250, to: 257, recipe: 'Arcanite Skeleton Key', alt: 'Big Black Mace', note: 'Needs Arcanite Bars; if none, Big Black Maces to 255' },
  { from: 257, to: 270, recipe: 'Ebon Shiv', note: 'Plans from Magnus Frostwake, Caer Darrow' },
  { from: 270, to: 275, recipe: 'Bold Dirk', alt: 'Ebon Shiv', note: 'Bold Dirk needs Azerothium; the Thorium route keeps making Ebon Shivs' },
  { from: 275, to: 279, recipe: 'Ornate Thorium Handaxe' },
  { from: 279, to: 300, recipe: 'Bold Dirk', alt: 'Ornate Thorium Handaxe' },
];

export const GUIDES: Record<string, GuideStep[]> = { Blacksmithing: BLACKSMITHING };
