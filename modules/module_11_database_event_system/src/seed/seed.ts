/**
 * Development / demo seed (Module 11).
 *
 * Usage:
 *   npm run db:seed
 *   SEED_DEMO_DATA=true npm run db:seed      # seed historical analytics too
 *
 * Why this file exists
 * --------------------
 * `package.json` declared `db:seed` pointing here, but the file was never
 * written, so `npm run db:setup` could not complete. This is that file.
 *
 * What it creates
 * ---------------
 *   1. A bootstrap operator, from SEED_OPERATOR_EMAIL / SEED_OPERATOR_PASSWORD.
 *   2. Hospitals with real capability and resource profiles (needed by Module 7).
 *   3. Ambulances with crews and equipment (needed by Module 6).
 *   4. Optionally, historical emergencies with events, outcomes and learning
 *      samples, so Module 12's analytics have something to aggregate.
 *
 * It is idempotent by natural key, not by wiping: re-running does not duplicate
 * rows and does not destroy recorded history. Use `npm run db:reset` for that.
 *
 * Provenance discipline
 * ---------------------
 * Seeded ambulances, hospitals and history are marked `isSimulation = true`, and
 * seeded learning samples carry provenance SIMULATION. Module 12 excludes them
 * from production aggregates unless the caller explicitly opts in. This is what
 * stops demo data from being reported as real clinical outcomes.
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { createId, DATA_PROVENANCE } from '@resus/core';
import { createModule11 } from '../module.js';
import { getPrismaClient } from '../db/client.js';

const db = getPrismaClient();
const module11 = createModule11({ db, ownsClient: false });

/** Bengaluru, matching MAP_DEFAULT_LAT/LNG in .env.example. */
const CENTRE = { latitude: 12.9716, longitude: 77.5946 };

const HOSPITALS = [
  {
    name: 'City General Hospital',
    latitude: 12.9784,
    longitude: 77.5912,
    status: 'OPEN',
    traumaLevel: 2,
    capabilities: ['ED_TRAUMA', 'ED_CARDIAC', 'GENERAL'],
    icuBedsTotal: 12,
    icuBedsFree: 4,
    edOpen: true,
    specialists: ['CARDIOLOGY', 'NEUROLOGY', 'TRAUMA_SURGERY'],
    equipment: ['DEFIBRILLATOR', 'ADVANCED_AIRWAY', 'CARDIAC_MONITOR', 'ECG'],
  },
  {
    name: 'Metro Cardiac Care Centre',
    latitude: 12.9352,
    longitude: 77.6245,
    status: 'OPEN',
    traumaLevel: 3,
    capabilities: ['ED_CARDIAC', 'CARDIAC_CATHETERISATION', 'GENERAL'],
    icuBedsTotal: 20,
    icuBedsFree: 2,
    edOpen: true,
    specialists: ['CARDIOLOGY', 'CARDIAC_SURGERY'],
    equipment: ['DEFIBRILLATOR', 'CARDIAC_MONITOR', 'ECG', 'ADVANCED_AIRWAY'],
  },
  {
    name: 'South District Trauma Centre',
    latitude: 12.9081,
    longitude: 77.5673,
    status: 'OPEN',
    traumaLevel: 1,
    capabilities: ['ED_TRAUMA', 'NEUROSURGERY', 'GENERAL'],
    icuBedsTotal: 8,
    icuBedsFree: 6,
    edOpen: true,
    specialists: ['NEUROSURGERY', 'TRAUMA_SURGERY', 'ORTHOPAEDICS'],
    equipment: ['TRAUMA_KIT', 'HAEMORRHAGE_KIT', 'DEFIBRILLATOR', 'SPINAL_BOARD'],
  },
  {
    name: 'Burns & Emergency Hospital',
    latitude: 13.0067,
    longitude: 77.5793,
    status: 'OPEN',
    traumaLevel: 2,
    capabilities: ['BURN_CENTRE', 'GENERAL'],
    icuBedsTotal: 6,
    icuBedsFree: 5,
    edOpen: true,
    specialists: ['PLASTIC_SURGERY', 'BURNS'],
    equipment: ['BURN_KIT', 'ADVANCED_AIRWAY'],
  },
  {
    // Deliberately BUSY with no free ICU: Module 7 must be able to demonstrate
    // rejecting a closer hospital on resource grounds rather than distance.
    name: 'Northside Multispecialty',
    latitude: 13.0451,
    longitude: 77.6321,
    status: 'BUSY',
    traumaLevel: 2,
    capabilities: ['ED_TRAUMA', 'RESPIRATORY', 'GENERAL'],
    icuBedsTotal: 10,
    icuBedsFree: 0,
    edOpen: true,
    specialists: ['RESPIRATORY', 'GENERAL'],
    equipment: ['OXYGEN', 'DEFIBRILLATOR'],
  },
  {
    name: 'Poison Control Referral Hospital',
    latitude: 12.9491,
    longitude: 77.6512,
    status: 'OPEN',
    traumaLevel: 2,
    capabilities: ['POISON_CONTROL', 'GENERAL'],
    icuBedsTotal: 5,
    icuBedsFree: 3,
    edOpen: true,
    specialists: ['TOXICOLOGY'],
    equipment: ['POISON_KIT', 'ADVANCED_AIRWAY', 'DEFIBRILLATOR'],
  },
];

const AMBULANCES = [
  {
    vehicleNumber: 'AMB001',
    latitude: 12.9756,
    longitude: 77.5986,
    stationName: 'Central Station',
    status: 'AVAILABLE',
    equipment: ['DEFIBRILLATOR', 'ADVANCED_AIRWAY', 'OXYGEN', 'CARDIAC_MONITOR', 'ECG'],
    crew: [
      { name: 'Lead Paramedic', role: 'PARAMEDIC', capabilities: ['PARAMEDIC', 'ADVANCED_LIFE_SUPPORT'] },
      { name: 'Driver', role: 'DRIVER', capabilities: ['BLS_TRANSPORT'] },
    ],
  },
  {
    vehicleNumber: 'AMB002',
    latitude: 12.9416,
    longitude: 77.5731,
    stationName: 'South Station',
    status: 'AVAILABLE',
    equipment: ['DEFIBRILLATOR', 'OXYGEN', 'TRAUMA_KIT', 'SPINAL_BOARD'],
    crew: [
      { name: 'Paramedic', role: 'PARAMEDIC', capabilities: ['PARAMEDIC', 'BLS_TRANSPORT'] },
      { name: 'Driver', role: 'DRIVER', capabilities: [] },
    ],
  },
  {
    vehicleNumber: 'AMB003',
    latitude: 12.9931,
    longitude: 77.6402,
    stationName: 'East Station',
    status: 'AVAILABLE',
    equipment: ['DEFIBRILLATOR', 'ADVANCED_AIRWAY', 'HAEMORRHAGE_KIT', 'CARDIAC_MONITOR'],
    crew: [
      { name: 'Critical Care Paramedic', role: 'PARAMEDIC', capabilities: ['PARAMEDIC', 'CRITICAL_CARE', 'ADVANCED_LIFE_SUPPORT'] },
      { name: 'Driver', role: 'DRIVER', capabilities: ['BLS_TRANSPORT'] },
    ],
  },
  {
    vehicleNumber: 'AMB004',
    latitude: 12.9177,
    longitude: 77.6221,
    stationName: 'South-East Station',
    status: 'AVAILABLE',
    equipment: ['OXYGEN', 'TRAUMA_KIT', 'SPINAL_BOARD', 'DEFIBRILLATOR'],
    crew: [
      { name: 'Trauma Paramedic', role: 'PARAMEDIC', capabilities: ['PARAMEDIC', 'TRAUMA_SPECIALIST'] },
      { name: 'Driver', role: 'DRIVER', capabilities: [] },
    ],
  },
  {
    // No DEFIBRILLATOR: exists so the Module 6 assignment engine can be observed
    // rejecting a unit on required-equipment grounds even when it is closest.
    vehicleNumber: 'AMB005',
    latitude: 12.9601,
    longitude: 77.6108,
    stationName: 'Transit Unit',
    status: 'AVAILABLE',
    equipment: ['OXYGEN', 'SPINAL_BOARD'],
    crew: [
      { name: 'First Responder', role: 'EMT', capabilities: ['BLS_TRANSPORT'] },
      { name: 'Driver', role: 'DRIVER', capabilities: [] },
    ],
  },
  {
    vehicleNumber: 'AMB006',
    latitude: 13.0201,
    longitude: 77.6055,
    stationName: 'North Station',
    status: 'AVAILABLE',
    equipment: ['DEFIBRILLATOR', 'ADVANCED_AIRWAY', 'CARDIAC_MONITOR', 'ECG', 'NEONATAL_KIT'],
    crew: [
      { name: 'Neonatal Paramedic', role: 'PARAMEDIC', capabilities: ['PARAMEDIC', 'PEDIATRIC_CARE', 'CRITICAL_CARE'] },
      { name: 'Driver', role: 'DRIVER', capabilities: ['BLS_TRANSPORT'] },
    ],
  },
];

async function seedOperator(): Promise<void> {
  const email = (process.env.SEED_OPERATOR_EMAIL ?? 'operator@resus.local').toLowerCase();
  const password = process.env.SEED_OPERATOR_PASSWORD ?? 'ChangeMe!2024';

  const existing = await module11.users.findByEmail(email);
  if (existing) {
    console.log(`[seed] operator ${email} already exists`);
    return;
  }

  await module11.users.create({
    email,
    displayName: 'Duty Operator',
    passwordHash: bcrypt.hashSync(password, 10),
    role: 'OPERATOR',
  });
  console.log(`[seed] created operator ${email}`);
  if (password === 'ChangeMe!2024') {
    console.log('[seed] WARNING: default password in use. Change SEED_OPERATOR_PASSWORD before any shared deployment.');
  }
}

async function seedHospitals(): Promise<void> {
  const existing = new Map(
    (await module11.hospitals.list({ includeSimulation: true })).map((h) => [h.name, h]),
  );

  for (const spec of HOSPITALS) {
    if (existing.has(spec.name)) continue;

    const id = createId('HSP');
    await db.hospital.create({
      data: {
        id,
        name: spec.name,
        latitude: spec.latitude,
        longitude: spec.longitude,
        status: spec.status,
        capabilitiesJson: JSON.stringify(spec.capabilities),
        traumaLevel: spec.traumaLevel,
        acceptingEmergencies: spec.edOpen,
        address: `${spec.name}, Bengaluru`,
        contactPhone: '+918000000000',
        isSimulation: true,
      },
    });

    // Resource rows are what Module 7 scores against: a hospital with no ICU
    // capacity is unsuitable for a cardiac arrest regardless of how close it is.
    await db.hospitalResource.createMany({
      data: [
        {
          id: createId('RSC'),
          hospitalId: id,
          resourceType: 'ICU_BED',
          code: '',
          total: spec.icuBedsTotal,
          available: spec.icuBedsFree,
          updatedAt: new Date(),
        },
        {
          id: createId('RSC'),
          hospitalId: id,
          resourceType: 'EMERGENCY_BED',
          code: '',
          total: spec.traumaLevel >= 2 ? 8 : 4,
          available: spec.edOpen ? (spec.traumaLevel >= 2 ? 3 : 2) : 0,
          updatedAt: new Date(),
        },
        ...spec.equipment.map((code) => ({
          id: createId('RSC'),
          hospitalId: id,
          resourceType: 'EQUIPMENT',
          code,
          total: 1,
          available: 1,
          updatedAt: new Date(),
        })),
        ...spec.specialists.map((specialty) => ({
          id: createId('RSC'),
          hospitalId: id,
          resourceType: 'SPECIALIST',
          code: specialty,
          total: 1,
          available: 1,
          updatedAt: new Date(),
        })),
      ],
    });

    console.log(`[seed] created hospital ${spec.name} (${id})`);
  }
}

async function seedAmbulances(): Promise<void> {
  const existing = new Map(
    (await module11.ambulances.list({ includeSimulation: true })).map((a) => [a.vehicleNumber, a]),
  );

  for (const spec of AMBULANCES) {
    if (existing.has(spec.vehicleNumber)) continue;
    await module11.ambulances.create({
      vehicleNumber: spec.vehicleNumber,
      latitude: spec.latitude,
      longitude: spec.longitude,
      stationName: spec.stationName,
      status: spec.status,
      equipment: spec.equipment,
      isSimulation: true,
      crew: spec.crew,
    });
    console.log(`[seed] created ambulance ${spec.vehicleNumber}`);
  }
}

/**
 * Historical emergencies so Module 12 has data to aggregate.
 *
 * Events are written through the event service rather than inserted directly, so
 * the append-only ordering, the broadcast path and the payload shape are all
 * exercised. `isSimulation` is set everywhere and the learning samples carry
 * SIMULATION provenance, which keeps these rows out of production aggregates.
 */
async function seedHistory(): Promise<void> {
  const wantHistory = ['1', 'true', 'yes', 'on'].includes(
    (process.env.SEED_DEMO_DATA ?? '').toLowerCase(),
  );
  if (!wantHistory) {
    console.log('[seed] SEED_DEMO_DATA not set; skipping historical analytics data');
    return;
  }

  const hospitals = await module11.hospitals.list({ includeSimulation: true });
  const ambulances = await module11.ambulances.list({ includeSimulation: true });
  if (hospitals.length === 0 || ambulances.length === 0) {
    console.log('[seed] no hospitals/ambulances to attach history to; skipping');
    return;
  }

  const existingHistory = await db.emergency.count({ where: { isSimulation: true } });
  if (existingHistory > 0) {
    console.log(`[seed] ${existingHistory} simulated emergencies already present; skipping history`);
    return;
  }

  const INCIDENTS = [
    { incidentType: 'CARDIAC_ARREST', severity: 'CRITICAL', survival: 0.45, protocol: 'cardiac-arrest-adult' },
    { incidentType: 'SEVERE_BLEEDING', severity: 'HIGH', survival: 0.85, protocol: 'severe-bleeding' },
    { incidentType: 'CHOKING', severity: 'CRITICAL', survival: 0.8, protocol: 'choking-adult' },
    { incidentType: 'CHEST_PAIN', severity: 'HIGH', survival: 0.9, protocol: 'general-triage' },
    { incidentType: 'TRAUMA', severity: 'HIGH', survival: 0.78, protocol: 'general-triage' },
    { incidentType: 'SEIZURE', severity: 'MEDIUM', survival: 0.94, protocol: 'active-seizure' },
  ];

  // Deterministic pseudo-random so repeated seeds produce the same analytics.
  let rng = 42;
  const rand = (): number => {
    rng = (rng * 1103515245 + 12345) % 2147483648;
    return rng / 2147483648;
  };

  const now = Date.now();
  const created: string[] = [];

  for (let i = 0; i < 60; i += 1) {
    const spec = INCIDENTS[i % INCIDENTS.length]!;
    const hospital = hospitals[i % hospitals.length]!;
    const ambulance = ambulances[i % ambulances.length]!;

    const ageHours = rand() * 24 * 29;
    const createdAt = new Date(now - ageHours * 3600_000);
    const responseMin = 4 + rand() * 9;
    const transportMin = 12 + rand() * 25;
    const totalMin = responseMin + transportMin + 8 + rand() * 10;
    const survived = rand() < spec.survival;

    const emergency = await module11.emergencies.create({
      incidentType: spec.incidentType,
      severity: spec.severity,
      latitude: CENTRE.latitude + (rand() - 0.5) * 0.08,
      longitude: CENTRE.longitude + (rand() - 0.5) * 0.08,
      description: `Seeded historical ${spec.incidentType.toLowerCase()} incident (simulation).`,
      isSimulation: true,
      actor: { actorType: 'SIMULATION' },
    });
    created.push(emergency.id);

    // Backdate the row so the event timestamps are consistent with `createdAt`.
    await db.emergency.update({
      where: { id: emergency.id },
      data: { createdAt, updatedAt: new Date(createdAt.getTime() + totalMin * 60_000) },
    });

    const callSession = await module11.calls.startSession({
      emergencyId: emergency.id,
      channel: 'VOICE',
      isSimulation: true,
    });

    await module11.calls.appendTranscript({
      callSessionId: callSession.id,
      emergencyId: emergency.id,
      speaker: 'CALLER',
      text: 'Seeded historical call transcript.',
      isFinal: true,
      isSimulation: true,
    });

    await module11.ambulances.createAssignment({
      emergencyId: emergency.id,
      ambulanceId: ambulance.id,
      distanceKm: 2 + rand() * 8,
      estimatedResponseTimeMin: responseMin,
      score: 70 + rand() * 25,
      matchingFactors: ['nearest-available', 'required-equipment-present'],
      rejectedReasons: {},
      consideredCandidates: 4,
      source: 'AUTOMATIC',
    });

    await module11.emergencies.update(emergency.id, {
      status: 'COMPLETED',
      assignedAmbulanceId: ambulance.id,
      selectedHospitalId: hospital.id,
    });

    await module11.outcomes.upsert({
      emergencyId: emergency.id,
      status: survived ? 'SURVIVED_TO_DISCHARGE' : 'DECEASED',
      survivalToDischarge: survived,
      provenance: DATA_PROVENANCE.SIMULATION,
      notes: 'Seeded simulation outcome.',
    });

    await module11.analyticsRead.insertLearningSample({
      emergencyId: emergency.id,
      hospitalId: hospital.id,
      emergencyType: spec.incidentType,
      severity: spec.severity,
      responseTimeMin: responseMin,
      ambulanceDistanceKm: 2 + rand() * 8,
      hospitalDistanceKm: 3 + rand() * 10,
      protocolUsed: spec.protocol,
      escalationRequired: spec.severity === 'CRITICAL',
      totalDurationMin: totalMin,
      transportTimeMin: transportMin,
      outcomeStatus: survived ? 'SURVIVED_TO_DISCHARGE' : 'DECEASED',
      survivalToDischarge: survived,
      features: { seeded: true },
      provenance: DATA_PROVENANCE.SIMULATION,
    });
  }

  console.log(`[seed] created ${created.length} simulated historical emergencies with outcomes`);
  console.log('[seed] all history is marked SIMULATION and is excluded from production aggregates by default');
}

async function main(): Promise<void> {
  console.log('[seed] starting');
  await seedOperator();
  await seedHospitals();
  await seedAmbulances();
  await seedHistory();

  const [hospitalCount, ambulanceCount] = await Promise.all([
    db.hospital.count(),
    db.ambulance.count(),
  ]);
  console.log(
    `[seed] done. hospitals=${hospitalCount} ambulances=${ambulanceCount}`,
  );
}

main()
  .then(async () => {
    await module11.dispose();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error('[seed] FAILED:', error instanceof Error ? error.message : error);
    if (error instanceof Error && error.stack) console.error(error.stack);
    await module11.dispose().catch(() => undefined);
    process.exit(1);
  });
