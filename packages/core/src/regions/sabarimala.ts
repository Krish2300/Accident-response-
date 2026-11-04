/**
 * Sabarimala pilgrim region: the service area, a landmark gazetteer covering
 * every pilgrim route, and the hospitals / ambulance posts used to seed the
 * system for this deployment.
 *
 * Routes covered:
 *  - Road approaches: Kottayam - Ponkunnam - Kanjirappally - Erumely - Mukkoottuthara
 *    - Kanamala - Nilakkal; Mundakayam - Erumely; Pathanamthitta - Ranni -
 *    Vadasserikkara - Laha - Plappally - Elavunkal - Nilakkal; Nilakkal - Attathode
 *    - Chalakayam - Pampa; Kumily - Vandiperiyar.
 *  - Main trek: Pampa - Neelimala - Appachimedu - Sabari Peedam - Marakoottam -
 *    Saramkuthi - Sannidhanam (with the Swami Ayyappan Road alternative).
 *  - Traditional forest path (Peruvazhi, from Erumely): Perurthode - Irumbunnikkara
 *    - Kalaketty - Azhutha - Kallidamkunnu - Inchipparakotta - Mukkuzhi - Karimala
 *    - Valiyanavattam - Cheriyanavattam - Pampa.
 *  - Pullumedu route: Vandiperiyar - Sathram - Pullumedu - Uppupara - Sannidhanam.
 *
 * IMPORTANT: coordinates are approximate (about ±1 km) and the hospital and
 * ambulance-post list is a planning baseline, not an official register. Both must
 * be verified with Kerala Police, the Health Department and the Travancore
 * Devaswom Board before operational use; edit this file to correct them.
 */

export type SabarimalaRoute =
  | 'SANNIDHANAM'
  | 'MAIN_TREK'
  | 'FOREST_PATH_ERUMELY'
  | 'PULLUMEDU'
  | 'ROAD_ERUMELY'
  | 'ROAD_PATHANAMTHITTA'
  | 'ROAD_NILAKKAL_PAMPA'
  | 'BASE';

export interface SabarimalaPlace {
  name: string;
  latitude: number;
  longitude: number;
  route: SabarimalaRoute;
  /** Spoken / written forms, English transliterations and Malayalam script. */
  aliases: string[];
  /** Vehicles cannot reach it: response is by stretcher / off-road unit. */
  footOnly?: boolean;
}

export const SABARIMALA_SERVICE_AREA = {
  name: 'Sabarimala pilgrim region',
  /** Pampa base: the default when a caller's location is not yet known. */
  centre: { latitude: 9.3897, longitude: 77.0594 },
  bounds: { south: 9.2, north: 9.66, west: 76.5, east: 77.2 },
  casePrefix: 'SBM',
};

export const SABARIMALA_PLACES: SabarimalaPlace[] = [
  // Sannidhanam and the main trek from Pampa
  { name: 'Sannidhanam', latitude: 9.4347, longitude: 77.0817, route: 'SANNIDHANAM', aliases: ['sannidhanam', 'sannidhanum', 'temple', 'pathinettam padi', '18 steps', 'eighteen steps', 'malikappuram', 'malikapuram', 'nadapanthal', 'സന്നിധാനം', 'പതിനെട്ടാംപടി', 'മാളികപ്പുറം'], footOnly: true },
  { name: 'Saramkuthi', latitude: 9.4315, longitude: 77.0805, route: 'MAIN_TREK', aliases: ['saramkuthi', 'sharamkuthi', 'saram kuthi', 'ശരംകുത്തി'], footOnly: true },
  { name: 'Marakoottam', latitude: 9.428, longitude: 77.079, route: 'MAIN_TREK', aliases: ['marakoottam', 'marakootam', 'marakuttam', 'മരക്കൂട്ടം'], footOnly: true },
  { name: 'Sabari Peedam', latitude: 9.421, longitude: 77.077, route: 'MAIN_TREK', aliases: ['sabari peedam', 'sabaripeedam', 'sabari peetam', 'ശബരീപീഠം'], footOnly: true },
  { name: 'Appachimedu', latitude: 9.4089, longitude: 77.0733, route: 'MAIN_TREK', aliases: ['appachimedu', 'appachi medu', 'appachimed', 'അപ്പാച്ചിമേട്'], footOnly: true },
  { name: 'Neelimala', latitude: 9.4, longitude: 77.07, route: 'MAIN_TREK', aliases: ['neelimala', 'neeli mala', 'nilimala', 'നീലിമല'], footOnly: true },
  { name: 'Swami Ayyappan Road', latitude: 9.405, longitude: 77.064, route: 'MAIN_TREK', aliases: ['swami ayyappan road', 'ayyappan road', 'tractor road', 'chandranandan road'], footOnly: true },
  { name: 'Pampa', latitude: 9.3897, longitude: 77.0594, route: 'BASE', aliases: ['pampa', 'pamba', 'triveni', 'pampa ganapathi', 'ganapathi kovil', 'pampa river', 'പമ്പ', 'ത്രിവേണി'] },
  { name: 'Chalakayam', latitude: 9.376, longitude: 77.05, route: 'ROAD_NILAKKAL_PAMPA', aliases: ['chalakayam', 'chalakkayam', 'ചാലക്കയം'] },
  { name: 'Attathode', latitude: 9.38, longitude: 77.028, route: 'ROAD_NILAKKAL_PAMPA', aliases: ['attathode', 'attathodu', 'അട്ടത്തോട്'] },
  { name: 'Nilakkal', latitude: 9.3706, longitude: 76.996, route: 'BASE', aliases: ['nilakkal', 'nilackal', 'nilakal', 'nilakkal parking', 'base camp', 'നിലയ്ക്കൽ'] },
  { name: 'Elavunkal', latitude: 9.36, longitude: 76.98, route: 'ROAD_PATHANAMTHITTA', aliases: ['elavunkal', 'elavungal', 'ഇലവുങ്കൽ'] },
  { name: 'Plappally', latitude: 9.346, longitude: 76.96, route: 'ROAD_PATHANAMTHITTA', aliases: ['plappally', 'plapally', 'പ്ലാപ്പള്ളി'] },
  { name: 'Laha', latitude: 9.333, longitude: 76.91, route: 'ROAD_PATHANAMTHITTA', aliases: ['laha', 'ളാഹ'] },
  { name: 'Vadasserikkara', latitude: 9.322, longitude: 76.835, route: 'ROAD_PATHANAMTHITTA', aliases: ['vadasserikkara', 'vadaserikara', 'വടശ്ശേരിക്കര'] },
  { name: 'Ranni', latitude: 9.383, longitude: 76.785, route: 'ROAD_PATHANAMTHITTA', aliases: ['ranni', 'റാന്നി'] },
  { name: 'Pathanamthitta', latitude: 9.2648, longitude: 76.787, route: 'ROAD_PATHANAMTHITTA', aliases: ['pathanamthitta', 'pathanamthita', 'പത്തനംതിട്ട'] },
  // Erumely and the road from Kottayam / Mundakayam
  { name: 'Erumely', latitude: 9.4818, longitude: 76.843, route: 'ROAD_ERUMELY', aliases: ['erumely', 'erumeli', 'erumeli petta', 'petta thullal', 'vavar', 'vavar mosque', 'vavar palli', 'എരുമേലി', 'വാവർ'] },
  { name: 'Mukkoottuthara', latitude: 9.429, longitude: 76.892, route: 'ROAD_ERUMELY', aliases: ['mukkoottuthara', 'mukkootuthara', 'mukkuttuthara', 'മുക്കൂട്ടുതറ'] },
  { name: 'Kanamala', latitude: 9.42, longitude: 76.915, route: 'ROAD_ERUMELY', aliases: ['kanamala', 'kanamala bridge', 'കണമല'] },
  { name: 'Mundakayam', latitude: 9.535, longitude: 76.887, route: 'ROAD_ERUMELY', aliases: ['mundakayam', 'mundakkayam', 'mundakayam bus stand', 'മുണ്ടക്കയം'] },
  { name: 'Kanjirappally', latitude: 9.558, longitude: 76.79, route: 'ROAD_ERUMELY', aliases: ['kanjirappally', 'kanjirapally', 'കാഞ്ഞിരപ്പള്ളി'] },
  { name: 'Ponkunnam', latitude: 9.566, longitude: 76.755, route: 'ROAD_ERUMELY', aliases: ['ponkunnam', 'പൊൻകുന്നം'] },
  { name: 'Kottayam', latitude: 9.5916, longitude: 76.5222, route: 'ROAD_ERUMELY', aliases: ['kottayam', 'kottayam railway station', 'കോട്ടയം'] },
  // Traditional forest path from Erumely (Peruvazhi)
  { name: 'Perurthode', latitude: 9.465, longitude: 76.87, route: 'FOREST_PATH_ERUMELY', aliases: ['perurthode', 'peroorthodu', 'perur thodu', 'പേരൂർത്തോട്'], footOnly: true },
  { name: 'Irumbunnikkara', latitude: 9.45, longitude: 76.895, route: 'FOREST_PATH_ERUMELY', aliases: ['irumbunnikkara', 'irumbunikara', 'ഇരുമ്പൂന്നിക്കര'], footOnly: true },
  { name: 'Kalaketty', latitude: 9.44, longitude: 76.93, route: 'FOREST_PATH_ERUMELY', aliases: ['kalaketty', 'kalakketti', 'kala ketti', 'കാളകെട്ടി'], footOnly: true },
  { name: 'Azhutha', latitude: 9.435, longitude: 76.965, route: 'FOREST_PATH_ERUMELY', aliases: ['azhutha', 'azhuthakadavu', 'azhutha river', 'alutha', 'അഴുത'], footOnly: true },
  { name: 'Kallidamkunnu', latitude: 9.43, longitude: 76.98, route: 'FOREST_PATH_ERUMELY', aliases: ['kallidamkunnu', 'kallidumkunnu', 'കല്ലിടാംകുന്ന്'], footOnly: true },
  { name: 'Inchipparakotta', latitude: 9.425, longitude: 77.0, route: 'FOREST_PATH_ERUMELY', aliases: ['inchipparakotta', 'inchippara', 'ഇഞ്ചിപ്പാറ'], footOnly: true },
  { name: 'Mukkuzhi', latitude: 9.418, longitude: 77.015, route: 'FOREST_PATH_ERUMELY', aliases: ['mukkuzhi', 'mukuzhi', 'മുക്കുഴി'], footOnly: true },
  { name: 'Karimala', latitude: 9.405, longitude: 77.035, route: 'FOREST_PATH_ERUMELY', aliases: ['karimala', 'kari mala', 'കരിമല'], footOnly: true },
  { name: 'Valiyanavattam', latitude: 9.395, longitude: 77.048, route: 'FOREST_PATH_ERUMELY', aliases: ['valiyanavattam', 'valiyana vattam', 'വലിയാനവട്ടം'], footOnly: true },
  { name: 'Cheriyanavattam', latitude: 9.392, longitude: 77.053, route: 'FOREST_PATH_ERUMELY', aliases: ['cheriyanavattam', 'cheriyana vattam', 'ചെറിയാനവട്ടം'], footOnly: true },
  // Pullumedu route
  { name: 'Uppupara', latitude: 9.46, longitude: 77.1, route: 'PULLUMEDU', aliases: ['uppupara', 'uppu para', 'ഉപ്പുപാറ'], footOnly: true },
  { name: 'Pullumedu', latitude: 9.49, longitude: 77.12, route: 'PULLUMEDU', aliases: ['pullumedu', 'pulmedu', 'pullu medu', 'പുല്ലുമേട്'], footOnly: true },
  { name: 'Sathram', latitude: 9.51, longitude: 77.11, route: 'PULLUMEDU', aliases: ['sathram', 'satram', 'സത്രം'] },
  { name: 'Vandiperiyar', latitude: 9.57, longitude: 77.088, route: 'PULLUMEDU', aliases: ['vandiperiyar', 'vandiperiyaar', 'വണ്ടിപ്പെരിയാർ'] },
  { name: 'Kumily', latitude: 9.605, longitude: 77.165, route: 'PULLUMEDU', aliases: ['kumily', 'kumili', 'കുമളി'] },
];

export interface SabarimalaHospitalSeed {
  name: string;
  latitude: number;
  longitude: number;
  status: 'OPEN' | 'BUSY';
  traumaLevel: number;
  capabilities: string[];
  icuBedsTotal: number;
  icuBedsFree: number;
  edOpen: boolean;
  specialists: string[];
  equipment: string[];
  address: string;
}

const h = (
  name: string, latitude: number, longitude: number, address: string,
  traumaLevel: number, capabilities: string[], icu: [number, number], specialists: string[], equipment: string[],
): SabarimalaHospitalSeed => ({
  name, latitude, longitude, address, traumaLevel,
  capabilities: [...new Set(capabilities)], specialists: [...new Set(specialists)], equipment: [...new Set(equipment)],
  status: 'OPEN', icuBedsTotal: icu[0], icuBedsFree: icu[1], edOpen: true,
});

const BASIC = ['DEFIBRILLATOR', 'OXYGEN', 'ADVANCED_AIRWAY'];
const CARDIAC = ['DEFIBRILLATOR', 'CARDIAC_MONITOR', 'ECG', 'OXYGEN', 'ADVANCED_AIRWAY'];
const TRAUMA = ['TRAUMA_KIT', 'HAEMORRHAGE_KIT', 'SPINAL_BOARD', 'DEFIBRILLATOR', 'OXYGEN'];

export const SABARIMALA_HOSPITALS: SabarimalaHospitalSeed[] = [
  h('Government Hospital Sannidhanam (seasonal)', 9.434, 77.081, 'Sannidhanam, Sabarimala', 3, ['ED_CARDIAC', 'GENERAL', 'RESPIRATORY'], [4, 2], ['CARDIOLOGY', 'GENERAL'], CARDIAC),
  h('Emergency Medical Centre Appachimedu', 9.4089, 77.0733, 'Appachimedu, Pampa-Sannidhanam trek', 3, ['ED_CARDIAC', 'GENERAL'], [0, 0], ['GENERAL'], BASIC),
  h('Emergency Medical Centre Neelimala', 9.4, 77.07, 'Neelimala, Pampa-Sannidhanam trek', 3, ['ED_CARDIAC', 'GENERAL'], [0, 0], ['GENERAL'], BASIC),
  h('Government Hospital Pampa', 9.3905, 77.0585, 'Pampa, Sabarimala', 2, ['ED_CARDIAC', 'ED_TRAUMA', 'GENERAL', 'RESPIRATORY'], [6, 3], ['CARDIOLOGY', 'TRAUMA_SURGERY', 'GENERAL'], [...CARDIAC, 'TRAUMA_KIT']),
  h('Government Hospital Nilakkal (seasonal)', 9.3712, 76.9955, 'Nilakkal base camp', 3, ['ED_CARDIAC', 'ED_TRAUMA', 'GENERAL'], [2, 1], ['GENERAL'], [...BASIC, 'TRAUMA_KIT']),
  h('Community Health Centre Erumely', 9.481, 76.845, 'Erumely, Kottayam', 3, ['ED_TRAUMA', 'GENERAL'], [0, 0], ['GENERAL'], [...BASIC, 'TRAUMA_KIT']),
  h('Government Hospital Mundakayam', 9.534, 76.886, 'Mundakayam, Kottayam', 3, ['ED_TRAUMA', 'GENERAL'], [2, 1], ['GENERAL'], [...BASIC, 'TRAUMA_KIT']),
  h('General Hospital Kanjirappally', 9.556, 76.788, 'Kanjirappally, Kottayam', 2, ['ED_TRAUMA', 'ED_CARDIAC', 'GENERAL'], [8, 3], ['CARDIOLOGY', 'TRAUMA_SURGERY', 'ORTHOPAEDICS'], [...CARDIAC, ...TRAUMA]),
  h('Taluk Hospital Ranni', 9.384, 76.787, 'Ranni, Pathanamthitta', 3, ['ED_TRAUMA', 'GENERAL'], [3, 1], ['GENERAL', 'ORTHOPAEDICS'], [...BASIC, 'TRAUMA_KIT']),
  h('General Hospital Pathanamthitta', 9.266, 76.785, 'Pathanamthitta town', 2, ['ED_TRAUMA', 'ED_CARDIAC', 'GENERAL', 'POISON_CONTROL'], [10, 4], ['CARDIOLOGY', 'TRAUMA_SURGERY', 'TOXICOLOGY'], [...CARDIAC, ...TRAUMA, 'POISON_KIT']),
  h('Government Medical College Konni', 9.235, 76.87, 'Konni, Pathanamthitta', 1, ['ED_TRAUMA', 'ED_CARDIAC', 'NEUROSURGERY', 'GENERAL', 'BURN_CENTRE'], [20, 6], ['CARDIOLOGY', 'NEUROSURGERY', 'TRAUMA_SURGERY', 'BURNS'], [...CARDIAC, ...TRAUMA, 'BURN_KIT']),
  h('Government Medical College Kottayam', 9.628, 76.536, 'Gandhinagar, Kottayam', 1, ['ED_TRAUMA', 'ED_CARDIAC', 'CARDIAC_CATHETERISATION', 'NEUROSURGERY', 'BURN_CENTRE', 'POISON_CONTROL', 'GENERAL'], [40, 10], ['CARDIOLOGY', 'CARDIAC_SURGERY', 'NEUROSURGERY', 'TRAUMA_SURGERY', 'BURNS', 'TOXICOLOGY'], [...CARDIAC, ...TRAUMA, 'BURN_KIT', 'POISON_KIT']),
  h('Community Health Centre Vandiperiyar', 9.57, 77.089, 'Vandiperiyar, Idukki', 3, ['ED_TRAUMA', 'GENERAL'], [0, 0], ['GENERAL'], [...BASIC, 'TRAUMA_KIT']),
];

export interface SabarimalaAmbulanceSeed {
  vehicleNumber: string;
  latitude: number;
  longitude: number;
  stationName: string;
  equipment: string[];
  crew: Array<{ name: string; role: string; capabilities: string[] }>;
}

const ALS = ['DEFIBRILLATOR', 'ADVANCED_AIRWAY', 'OXYGEN', 'CARDIAC_MONITOR', 'ECG'];
const BLS = ['DEFIBRILLATOR', 'OXYGEN', 'TRAUMA_KIT', 'SPINAL_BOARD'];
const crewAls = [
  { name: 'Paramedic', role: 'PARAMEDIC', capabilities: ['PARAMEDIC', 'ADVANCED_LIFE_SUPPORT'] },
  { name: 'Driver', role: 'DRIVER', capabilities: ['BLS_TRANSPORT'] },
];
const crewTrek = [
  { name: 'Emergency Medical Technician', role: 'EMT', capabilities: ['BLS_TRANSPORT'] },
  { name: 'Stretcher team', role: 'DRIVER', capabilities: [] },
];
const unit = (n: number, place: string, latitude: number, longitude: number, equipment: string[], trek = false): SabarimalaAmbulanceSeed => ({
  vehicleNumber: `SBM-AMB-${String(n).padStart(2, '0')}`,
  latitude, longitude, equipment,
  stationName: `${place}${trek ? ' (off-road / stretcher unit)' : ''}`,
  crew: trek ? crewTrek : crewAls,
});

export const SABARIMALA_AMBULANCES: SabarimalaAmbulanceSeed[] = [
  unit(1, 'Sannidhanam', 9.4342, 77.0812, ALS, true),
  unit(2, 'Sannidhanam', 9.4345, 77.0815, ALS, true),
  unit(3, 'Marakoottam', 9.428, 77.079, BLS, true),
  unit(4, 'Appachimedu', 9.4089, 77.0733, ALS, true),
  unit(5, 'Pampa', 9.3897, 77.0594, ALS),
  unit(6, 'Pampa', 9.39, 77.0598, ALS),
  unit(7, 'Pampa', 9.3893, 77.059, BLS),
  unit(8, 'Chalakayam', 9.376, 77.05, BLS),
  unit(9, 'Nilakkal', 9.3706, 76.996, ALS),
  unit(10, 'Nilakkal', 9.371, 76.9965, BLS),
  unit(11, 'Laha', 9.333, 76.91, BLS),
  unit(12, 'Kanamala', 9.42, 76.915, BLS),
  unit(13, 'Erumely', 9.4818, 76.843, ALS),
  unit(14, 'Erumely', 9.482, 76.8435, BLS),
  unit(15, 'Mundakayam', 9.535, 76.887, ALS),
  unit(16, 'Azhutha (forest path)', 9.435, 76.965, BLS, true),
  unit(17, 'Pullumedu', 9.49, 77.12, BLS, true),
  unit(18, 'Vandiperiyar', 9.57, 77.088, ALS),
  unit(19, 'Pathanamthitta', 9.2648, 76.787, ALS),
];

export interface PlaceMatch {
  place: SabarimalaPlace;
  alias: string;
  confidence: number;
}

function normalise(text: string): string {
  return ` ${text.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
}

/**
 * Finds the landmark the caller is AT. Each mention is scored: longer (more
 * specific) aliases score higher; a mention right after "near / at / in /
 * above / below / beside" is boosted, and one after "to / towards / going to"
 * (a destination, not the caller's position) is penalised. So "collapsed near
 * Appachimedu on the way to Sannidhanam" resolves to Appachimedu.
 */
export function findSabarimalaPlace(text: string): PlaceMatch | null {
  const haystack = normalise(text);
  let best: (PlaceMatch & { score: number }) | null = null;
  for (const place of SABARIMALA_PLACES) {
    for (const alias of place.aliases) {
      const needle = normalise(alias);
      let from = 0;
      for (let at = haystack.indexOf(needle, from); at >= 0; at = haystack.indexOf(needle, from)) {
        from = at + 1;
        const before = haystack.slice(Math.max(0, at - 24), at + 1);
        let score = needle.trim().length;
        if (/ (near|at|in|on|above|below|beside|behind|opposite|inside|outside|reached|around) (the )?$/.test(before)) score += 30;
        if (/ (to|towards|toward|for|till|until|way to|going to) (the )?$/.test(before)) score -= 30;
        if (!best || score > best.score) {
          best = { place, alias, confidence: needle.trim().length >= 6 ? 0.9 : 0.75, score };
        }
      }
    }
  }
  if (!best) return null;
  const { score: _score, ...match } = best;
  return match;
}

export function isInSabarimalaServiceArea(latitude: number, longitude: number): boolean {
  const b = SABARIMALA_SERVICE_AREA.bounds;
  return latitude >= b.south && latitude <= b.north && longitude >= b.west && longitude <= b.east;
}

/** Nearest gazetteer place to a coordinate (for labelling GPS calls by route/landmark). */
export function nearestSabarimalaPlace(latitude: number, longitude: number): { place: SabarimalaPlace; distanceKm: number } {
  let best = { place: SABARIMALA_PLACES[0]!, distanceKm: Number.POSITIVE_INFINITY };
  for (const place of SABARIMALA_PLACES) {
    const dLat = (place.latitude - latitude) * 111.32;
    const dLng = (place.longitude - longitude) * 111.32 * Math.cos((latitude * Math.PI) / 180);
    const distanceKm = Math.sqrt(dLat * dLat + dLng * dLng);
    if (distanceKm < best.distanceKm) best = { place, distanceKm };
  }
  return best;
}
