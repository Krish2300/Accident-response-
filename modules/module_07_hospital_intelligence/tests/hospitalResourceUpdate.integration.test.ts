import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { AppError, createId } from '@resus/core';
import { createModule11, type Module11 } from '@resus/data';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from '../../../tests/helpers/isolatedTestDatabase.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../');
const prismaDir = resolve(repoRoot, 'modules/module_11_database_event_system/prisma');
const schemaPath = resolve(prismaDir, 'schema.prisma');

describe('Hospital resource update integration (HOSPITAL_RESOURCE_UPDATED)', () => {
  let db: PrismaClient;
  let module11: Module11;
  let testDatabase: IsolatedTestDatabase;
  let hospitalId: string;

  beforeAll(async () => {
    testDatabase = await createIsolatedTestDatabase({ repoRoot, schemaPath });
    db = new PrismaClient({ datasources: { db: { url: testDatabase.databaseUrl } } });
    module11 = createModule11({ db, ownsClient: false });

    hospitalId = createId('HSP');
    await db.hospital.create({
      data: {
        id: hospitalId,
        name: 'Resource Hospital',
        latitude: 12.97,
        longitude: 77.59,
        status: 'OPEN',
        capabilitiesJson: JSON.stringify(['ED_CARDIAC']),
        traumaLevel: 2,
        acceptingEmergencies: true,
        address: 'Resource Hospital, Bengaluru',
        isSimulation: false,
      },
    });
    await db.hospitalResource.createMany({
      data: [
        { id: createId('RSC'), hospitalId, resourceType: 'ICU_BED', code: '', total: 10, available: 2, updatedAt: new Date() },
        { id: createId('RSC'), hospitalId, resourceType: 'EQUIPMENT', code: 'DEFIBRILLATOR', total: 4, available: 1, updatedAt: new Date() },
      ],
    });
  }, 120000);

  afterAll(async () => {
    await db?.$disconnect();
    testDatabase?.cleanup();
  });

  async function resourceEvents() {
    const page = await module11.eventQuery.list({ types: ['HOSPITAL_RESOURCE_UPDATED'], limit: 100 });
    return page.items;
  }

  it('persists the new counts and records exactly one correctly shaped durable event', async () => {
    const updated = await module11.hospitals.updateResourceAvailability({
      hospitalId,
      resourceType: 'ICU_BED',
      total: 12,
      available: 5,
      actor: { actorType: 'OPERATOR', actorId: 'U-OP' },
    });

    expect(updated).toMatchObject({ hospitalId, resourceType: 'ICU_BED', total: 12, available: 5 });

    const stored = await db.hospitalResource.findUnique({
      where: { hospitalId_resourceType_code: { hospitalId, resourceType: 'ICU_BED', code: '' } },
    });
    expect(stored).toMatchObject({ total: 12, available: 5 });

    const events = await resourceEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'HOSPITAL_RESOURCE_UPDATED',
      entityType: 'hospital',
      entityId: hospitalId,
      emergencyId: null,
      actorType: 'OPERATOR',
      actorId: 'U-OP',
      payload: { hospitalId, resourceType: 'ICU_BED', code: '', total: 12, available: 5 },
    });
  });

  it('records coded equipment updates with the code in the payload', async () => {
    const updated = await module11.hospitals.updateResourceAvailability({
      hospitalId,
      resourceType: 'EQUIPMENT',
      code: 'DEFIBRILLATOR',
      total: 4,
      available: 3,
    });
    expect(updated).toMatchObject({ resourceType: 'EQUIPMENT', code: 'DEFIBRILLATOR', available: 3 });

    const events = await resourceEvents();
    const coded = events.filter((event) =>
      (event.payload as { code?: string }).code === 'DEFIBRILLATOR',
    );
    expect(coded).toHaveLength(1);
    expect(coded[0]!.payload).toMatchObject({ total: 4, available: 3 });
  });

  it('rolls back the write and records no success event when the resource row does not exist', async () => {
    await expect(
      module11.hospitals.updateResourceAvailability({
        hospitalId,
        resourceType: 'OPERATION_THEATRE',
        total: 1,
        available: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    const stored = await db.hospitalResource.findUnique({
      where: { hospitalId_resourceType_code: { hospitalId, resourceType: 'OPERATION_THEATRE', code: '' } },
    });
    expect(stored).toBeNull();
    expect((await resourceEvents()).filter((event) =>
      (event.payload as { resourceType?: string }).resourceType === 'OPERATION_THEATRE',
    )).toHaveLength(0);
  });

  it('rejects invalid counts and unknown resource types before any write or event', async () => {
    const before = (await resourceEvents()).length;

    await expect(
      module11.hospitals.updateResourceAvailability({ hospitalId, resourceType: 'ICU_BED', total: 10, available: 11 }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      module11.hospitals.updateResourceAvailability({ hospitalId, resourceType: 'NOT_A_TYPE', total: 1, available: 1 }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      module11.hospitals.updateResourceAvailability({ hospitalId, resourceType: 'ICU_BED', total: -1, available: 0 }),
    ).rejects.toBeInstanceOf(AppError);

    const stored = await db.hospitalResource.findUnique({
      where: { hospitalId_resourceType_code: { hospitalId, resourceType: 'ICU_BED', code: '' } },
    });
    expect(stored).toMatchObject({ total: 12, available: 5 });
    expect((await resourceEvents()).length).toBe(before);
  });
});
