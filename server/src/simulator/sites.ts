/**
 * The sites in the mock enterprise: Dublin is the full reference plant, and ten more around Ireland each run
 * their own line configuration. Topics are acme/<site id>/<area>/<line or unit>/<cell>/<tag>.
 */

export interface Product {
  sku: string;
  name: string;
}

export interface LineConfig {
  id: string;
  ratedBpm: number;
  products: Product[];
  operator: string;
  /** Lines that pack bags or trays have no capper. */
  capper?: boolean;
  /** Publishes a nested JSON snapshot of the palletizer robot controller. */
  robot?: boolean;
}

export interface MixerConfig {
  id: string;
  recipe: string;
  operator: string;
}

export interface SiteConfig {
  id: string;
  name: string;
  county: string;
  lat: number;
  lon: number;
  sector: string;
  headcount: number;
  lines: LineConfig[];
  mixers: MixerConfig[];
  /** Oven zone setpoints in °C; no oven when absent. */
  oven?: number[];
  cip: boolean;
  compressors: number;
  boiler: boolean;
  /** Publish intervals are multiplied by this, so the smaller sites add less traffic. */
  rate: number;
  /** Minutes between random faults. */
  faultEvery: [number, number];
}

const line = (id: string, ratedBpm: number, operator: string, products: [string, string][], opts: Partial<LineConfig> = {}): LineConfig => ({
  id,
  ratedBpm,
  operator,
  products: products.map(([sku, name]) => ({ sku, name })),
  capper: true,
  ...opts,
});

export const SITES: SiteConfig[] = [
  {
    id: "dublin", name: "Dublin", county: "Dublin", lat: 53.3498, lon: -6.2603, sector: "Soft drinks", headcount: 42,
    lines: [
      line("line1", 120, "A. Byrne", [["CL-330", "Cola 330ml can"], ["CL-500", "Cola 500ml PET"]]),
      line("line2", 100, "C. Murphy", [["LM-330", "Lemon 330ml can"], ["OR-1L", "Orange 1L PET"]], { robot: true }),
      line("line3", 150, "D. O'Neill", [["WT-500", "Still water 500ml PET"], ["SP-500", "Sparkling water 500ml PET"]]),
      line("line4", 90, "R. Quinn", [["EN-250", "Energy 250ml can"], ["IT-330", "Iced tea 330ml glass"]]),
    ],
    mixers: [{ id: "mixer1", recipe: "Syrup base v3", operator: "M. Walsh" }, { id: "mixer2", recipe: "Citrus concentrate v7", operator: "S. Kelly" }],
    oven: [180, 210, 195], cip: true, compressors: 2, boiler: true, rate: 1, faultEvery: [4, 8],
  },
  {
    id: "cork", name: "Cork", county: "Cork", lat: 51.8985, lon: -8.4756, sector: "Dairy", headcount: 58,
    lines: [
      line("line1", 140, "N. O'Sullivan", [["MK-1L", "Whole milk 1L carton"], ["MK-2L", "Whole milk 2L bottle"]]),
      line("line2", 110, "E. McCarthy", [["SK-1L", "Skimmed milk 1L carton"], ["BT-500", "Buttermilk 500ml"]]),
      line("line3", 80, "P. Lynch", [["YG-150", "Strawberry yoghurt 150g"], ["YG-500", "Natural yoghurt 500g"]], { capper: false }),
    ],
    mixers: [{ id: "pasteuriser1", recipe: "HTST milk 72°C/15s", operator: "J. Crowley" }, { id: "culture_tank1", recipe: "Yoghurt culture YC-12", operator: "B. Daly" }],
    cip: true, compressors: 2, boiler: true, rate: 2, faultEvery: [15, 30],
  },
  {
    id: "galway", name: "Galway", county: "Galway", lat: 53.2707, lon: -9.0568, sector: "Spring water", headcount: 24,
    lines: [
      line("line1", 220, "F. Joyce", [["SW-500", "Spring water 500ml PET"], ["SW-750", "Sports cap 750ml PET"]], { robot: true }),
      line("line2", 180, "K. Burke", [["SW-2L", "Spring water 2L PET"], ["SP-1L", "Sparkling 1L PET"]]),
    ],
    mixers: [], cip: true, compressors: 2, boiler: false, rate: 2, faultEvery: [15, 30],
  },
  {
    id: "limerick", name: "Limerick", county: "Limerick", lat: 52.6638, lon: -8.6267, sector: "Bakery", headcount: 61,
    lines: [
      line("line1", 60, "T. Ryan", [["BR-800", "White sliced pan 800g"], ["BR-WM", "Wholemeal 800g"]], { capper: false }),
      line("line2", 95, "L. O'Brien", [["RL-6", "Breakfast rolls x6"], ["SC-4", "Fruit scones x4"]], { capper: false }),
    ],
    mixers: [{ id: "dough_mixer1", recipe: "White dough D-3", operator: "G. Hayes" }, { id: "dough_mixer2", recipe: "Wholemeal dough D-7", operator: "A. Collins" }],
    oven: [215, 235, 205], cip: false, compressors: 1, boiler: false, rate: 2, faultEvery: [15, 30],
  },
  {
    id: "waterford", name: "Waterford", county: "Waterford", lat: 52.2593, lon: -7.1101, sector: "Juice", headcount: 33,
    lines: [
      line("line1", 100, "C. Power", [["AP-1L", "Apple juice 1L carton"], ["OJ-1L", "Orange juice 1L carton"]]),
      line("line2", 130, "M. Walsh", [["SM-250", "Smoothie 250ml PET"], ["AP-250", "Apple 250ml PET"]]),
    ],
    mixers: [{ id: "blend_tank1", recipe: "Apple from concentrate AJ-2", operator: "D. Phelan" }],
    cip: true, compressors: 1, boiler: true, rate: 2, faultEvery: [15, 30],
  },
  {
    id: "kilkenny", name: "Kilkenny", county: "Kilkenny", lat: 52.6541, lon: -7.2448, sector: "Brewery", headcount: 47,
    lines: [
      line("line1", 160, "S. Brennan", [["RA-500", "Red ale 500ml can"], ["RA-440", "Red ale 440ml can"]], { robot: true }),
      line("line2", 70, "P. Dunne", [["ST-330", "Stout 330ml glass"], ["LG-330", "Lager 330ml glass"]]),
    ],
    mixers: [{ id: "brew_kettle1", recipe: "Red ale wort RA-5", operator: "J. Comerford" }, { id: "brew_kettle2", recipe: "Stout wort ST-2", operator: "N. Holohan" }],
    cip: true, compressors: 2, boiler: true, rate: 2, faultEvery: [15, 30],
  },
  {
    id: "sligo", name: "Sligo", county: "Sligo", lat: 54.2766, lon: -8.4761, sector: "Snacks", headcount: 29,
    lines: [line("line1", 110, "R. Gallagher", [["CR-40", "Sea salt crisps 40g"], ["CR-150", "Cheese & onion 150g"]], { capper: false })],
    mixers: [{ id: "seasoning_drum1", recipe: "Sea salt S-1", operator: "E. Feeney" }],
    oven: [175, 190], cip: false, compressors: 1, boiler: false, rate: 2, faultEvery: [15, 30],
  },
  {
    id: "athlone", name: "Athlone", county: "Westmeath", lat: 53.4239, lon: -7.9407, sector: "Soft drinks", headcount: 39,
    lines: [
      line("line1", 140, "B. Kenny", [["GA-330", "Ginger ale 330ml can"], ["TN-330", "Tonic 330ml can"]], { robot: true }),
      line("line2", 120, "C. Fallon", [["LE-500", "Lemonade 500ml PET"], ["LE-2L", "Lemonade 2L PET"]]),
      line("line3", 90, "H. Dolan", [["OR-200", "Orange 200ml glass"], ["CL-200", "Cola 200ml glass"]]),
    ],
    mixers: [{ id: "syrup_room1", recipe: "Ginger syrup G-4", operator: "T. Egan" }],
    cip: true, compressors: 2, boiler: true, rate: 2, faultEvery: [15, 30],
  },
  {
    id: "drogheda", name: "Drogheda", county: "Louth", lat: 53.7179, lon: -6.3561, sector: "Dairy desserts", headcount: 36,
    lines: [
      line("line1", 85, "M. Reilly", [["RP-125", "Rice pudding 125g"], ["CU-125", "Custard pot 125g"]], { capper: false }),
      line("line2", 70, "S. Clarke", [["CH-500", "Cheesecake 500g"], ["TR-400", "Trifle 400g"]], { capper: false }),
    ],
    mixers: [{ id: "cook_kettle1", recipe: "Rice pudding RP-3", operator: "A. Matthews" }, { id: "cook_kettle2", recipe: "Vanilla custard VC-1", operator: "P. Rooney" }],
    cip: true, compressors: 1, boiler: true, rate: 2, faultEvery: [15, 30],
  },
  {
    id: "letterkenny", name: "Letterkenny", county: "Donegal", lat: 54.9503, lon: -7.7339, sector: "Ready meals", headcount: 52,
    lines: [line("line1", 45, "D. McGinley", [["RM-CC", "Chicken curry 400g"], ["RM-SB", "Spaghetti bolognese 400g"]], { capper: false })],
    mixers: [{ id: "sauce_kettle1", recipe: "Curry sauce CS-2", operator: "K. Bonner" }],
    oven: [190, 165], cip: true, compressors: 1, boiler: true, rate: 2, faultEvery: [15, 30],
  },
  {
    id: "tralee", name: "Tralee", county: "Kerry", lat: 52.2713, lon: -9.7026, sector: "Sauces", headcount: 31,
    lines: [
      line("line1", 75, "J. O'Connor", [["KS-500", "Ketchup 500ml squeezy"], ["BB-500", "Barbecue 500ml squeezy"]]),
      line("line2", 60, "M. Fitzgerald", [["MY-1L", "Mayonnaise 1L jar"], ["GS-250", "Garlic sauce 250ml"]]),
    ],
    mixers: [{ id: "batch_kettle1", recipe: "Tomato ketchup TK-8", operator: "R. Moriarty" }, { id: "emulsifier1", recipe: "Mayonnaise MY-3", operator: "C. Sheehy" }],
    cip: true, compressors: 2, boiler: true, rate: 2, faultEvery: [15, 30],
  },
];
