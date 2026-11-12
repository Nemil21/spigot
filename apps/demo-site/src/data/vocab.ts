// Word lists for the fictional site. Geography is real (Austin area, not a brand);
// every business name here is invented. Review before recording (features/01 edge cases).

export const NEIGHBOURHOODS: Record<string, string[]> = {
  Austin: [
    'Travis Heights',
    'Bouldin Creek',
    'Zilker',
    'Hyde Park',
    'Mueller',
    'Holly',
    'Clarksville',
    'Tarrytown',
    'North Loop',
    'Crestview',
    'Allandale',
    'Brentwood',
    'Windsor Park',
    'Cherrywood',
    'Barton Hills',
    'Govalle',
    'St. Johns',
    'Rosedale',
  ],
  'Round Rock': ['Old Town Round Rock', 'Brushy Creek'],
  Pflugerville: ['Old Town Pflugerville', 'Gilleland Creek'],
  'Cedar Park': ['Cedar Park Town Center', 'Anderson Mill'],
  Georgetown: ['Georgetown Square', 'San Gabriel'],
  Buda: ['Old Town Buda'],
};

/** Weighted towards Austin so most listings are in the city. */
export const CITY_WEIGHTS: { weight: number; value: string }[] = [
  { weight: 70, value: 'Austin' },
  { weight: 8, value: 'Round Rock' },
  { weight: 7, value: 'Pflugerville' },
  { weight: 6, value: 'Cedar Park' },
  { weight: 5, value: 'Georgetown' },
  { weight: 4, value: 'Buda' },
];

export const POSTAL_PREFIX: Record<string, string> = {
  Austin: '787',
  'Round Rock': '786',
  Pflugerville: '786',
  'Cedar Park': '786',
  Georgetown: '786',
  Buda: '786',
};

/** Rent multiplier by city; suburbs run a little cheaper. */
export const CITY_PRICE_FACTOR: Record<string, number> = {
  Austin: 1,
  'Round Rock': 0.88,
  Pflugerville: 0.85,
  'Cedar Park': 0.9,
  Georgetown: 0.84,
  Buda: 0.82,
};

/** Monthly rent band (USD) by bedroom count, before the city factor. */
export const RENT_BAND: Record<number, [number, number]> = {
  0: [1000, 1400],
  1: [1150, 1750],
  2: [1500, 2350],
  3: [2000, 3200],
  4: [2600, 4000],
};

export const STREET_NAMES = [
  'Live Oak',
  'Pecan Grove',
  'Limestone',
  'Cedar Elm',
  'Mockingbird',
  'Larkspur',
  'Prickly Pear',
  'Agave',
  'Caliche',
  'Redbud',
  'Mesquite',
  'Yaupon',
  'Sotol',
  'Juniper Ridge',
  'Grackle',
  'Indigo Bush',
  'Coneflower',
  'Paintbrush',
  'Sycamore Bend',
  'Cypress Hollow',
  'Firewheel',
  'Spanish Oak',
  'Kestrel',
  'Bur Oak',
  'Lantana',
  'Sage Meadow',
  'Copper Leaf',
  'Pinto Bean',
  'Windmill',
  'Armadillo',
];

export const STREET_SUFFIXES = ['St', 'Ave', 'Dr', 'Ln', 'Ct', 'Trl', 'Blvd', 'Way', 'Pass', 'Cv'];

export const UNIT_KINDS = ['Apt', 'Unit', '#'];

/** Invented brokerages. None of these is meant to be a real company. */
export const BROKERAGES = [
  'Caliche & Pine Leasing',
  'Prickly Pear Property Collective',
  'Limestone Lantern Realty',
  'Cedar Elm Leasing Co.',
  'Larkspur Lane Homes',
  'Agave Row Rentals',
  'Mockingbird Mile Realty',
  'Pecan Hollow Partners',
];

export const LANGUAGES = ['English', 'Spanish', 'Vietnamese', 'Mandarin', 'Hindi', 'Korean', 'French'];

export const TITLE_ADJECTIVES = [
  'Sunny',
  'Quiet',
  'Updated',
  'Bright',
  'Shaded',
  'Renovated',
  'Cozy',
  'Spacious',
  'Light-filled',
  'Walkable',
];

export const FEATURES = [
  'in-unit washer and dryer',
  'a covered parking spot',
  'a shaded back patio',
  'new vinyl plank floors',
  'a gas range',
  'ceiling fans in every room',
  'a fenced yard',
  'a walk-in closet',
  'quartz counters',
  'a second-floor balcony',
  'a community pool',
  'a dog run next door',
  'bike storage',
  'a home office nook',
];

export const NEARBY = [
  'a short walk to the bus line',
  'close to the hike-and-bike trail',
  'near coffee shops and taco trucks',
  'a few minutes from the greenbelt',
  'near the neighbourhood library',
  'next to a quiet pocket park',
  'an easy bike ride to downtown',
];

export const PETS: { weight: number; value: 'Yes' | 'No' | 'Cats only' | 'Dogs only' }[] = [
  { weight: 45, value: 'Yes' },
  { weight: 30, value: 'No' },
  { weight: 18, value: 'Cats only' },
  { weight: 7, value: 'Dogs only' },
];

export const OPEN_HOUSE_NOTES = [
  'Park on the street; the gate code is posted at the door.',
  'Bring a photo ID. Applications on site.',
  'Shoe covers provided. Please be on time.',
  'Meet the agent in the leasing office first.',
  'Pets on the property; please keep doors closed.',
];
