import type { PrismaClient } from '@prisma/client';
import { guardDatabase } from '../db/client.js';
import { parseJsonColumn, parseRecord } from '../models/mappers.js';

/**
 * Read-only projection layer.
 *
 * Module 12 depends on this interface, never on tables. There is intentionally
 * no `create`/`update`/`delete` anywhere in this file: the dashboard can read
 * the domain, and only the owning module can write it.
 */

export interface EmergencyDurationRow {
  emergencyId: string;
  createdAt: string;
  completedAt: string | null;
  status: string;
  incidentType: string;
  severity: string;
  isSimulation: boolean;
  /** Call received -> ambulance on scene. */
  responseTimeMin: number | null;
  /** Assignment -> dispatch. */
  dispatchTimeMin: number | null;
  /** Dispatch -> on scene. */
  ambulanceTravelMin: number | null;
  /** Patient onboard -> hospital arrival. */
  transportTimeMin: number | null;
  /** Call received -> hospital arrival. */
  totalDurationMin: number | null;
  hospitalId: string | null;
  ambulanceId: string | null;
  protocolId: string | null;
  escalationRequired: boolean;
}

export interface LiveAmbulanceRow {
  id: string;
  vehicleNumber: string;
  status: string;
  latitude: number | null;
  longitude: number | null;
  lastLocationUpdate: string | null;
  currentEmergencyId: string | null;
  isSimulation: boolean;
  crewCount: number;
  equipment: string[];
}

export interface LiveEmergencyRow {
  id: string;
  status: string;
  incidentType: string;
  severity: string;
  latitude: number;
  longitude: number;
  createdAt: string;
  assignedAmbulanceId: string | null;
  selectedHospitalId: string | null;
  isSimulation: boolean;
}

export interface LiveCorridorRow {
  id: string;
  emergencyId: string;
  ambulanceId: string;
  hospitalId: string;
  fromLabel: string;
  toLabel: string;
  estimatedMinutes: number;
  activatedAt: string;
  isSimulation: boolean;
}

export interface LearningSampleRow {
  emergencyId: string;
  emergencyType: string;
  severity: string;
  responseTimeMin: number | null;
  dispatchTimeMin: number | null;
  ambulanceDistanceKm: number | null;
  hospitalDistanceKm: number | null;
  protocolUsed: string | null;
  protocolVersion: string | null;
  escalationRequired: boolean;
  routeDurationMin: number | null;
  transportTimeMin: number | null;
  totalDurationMin: number | null;
  outcomeStatus: string;
  survivalToDischarge: boolean | null;
  features: Record<string, unknown>;
  provenance: string;
  recordedAt: string;
  isSimulation: boolean;
}

const EVENT_MARKERS = {
  created: null as null,
  classified: 'EMERGENCY_CLASSIFIED',
  protocolStarted: 'PROTOCOL_STARTED',
  assigned: 'AMBULANCE_ASSIGNED',
  dispatched: 'AMBULANCE_DISPATCHED',
  arrivedScene: 'AMBULANCE_ARRIVED_SCENE',
  onboard: 'PATIENT_ONBOARD',
  hospitalSelected: 'HOSPITAL_SELECTED',
  arrivedHospital: 'AMBULANCE_ARRIVED_HOSPITAL',
  completed: 'EMERGENCY_COMPLETED',
} as const;

type MarkerKey = keyof typeof EVENT_MARKERS;

const diffMin = (from: string | null, to: string | null): number | null => {
  if (!from || !to) return null;
  const value = (Date.parse(to) - Date.parse(from)) / 60000;
  return value < 0 ? null : Math.round(value * 100) / 100;
};

export class AnalyticsReadRepository {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Recomputes timing intervals from the append-only event log. This is the
   * only place response/dispatch/transport times come from — nothing is stored
   * twice and nothing is estimated unless the log is incomplete.
   */
  async emergencyDurations(
    windowDays: number,
    includeSimulation: boolean,
  ): Promise<EmergencyDurationRow[]> {
    return guardDatabase(async () => {
      const since = new Date(Date.now() - windowDays * 86400000);
      const rows = await this.db.emergency.findMany({
        where: {
          createdAt: { gte: since },
          ...(includeSimulation ? {} : { isSimulation: false }),
        },
        orderBy: { createdAt: 'desc' },
        take: 1000,
        select: {
          id: true,
          createdAt: true,
          updatedAt: true,
          status: true,
          incidentType: true,
          severity: true,
          isSimulation: true,
          assignedAmbulanceId: true,
          selectedHospitalId: true,
          systemEvents: {
            orderBy: { seq: 'asc' },
            select: { type: true, recordedAt: true, payloadJson: true },
          },
          protocolSessions: { select: { protocolId: true, escalationRequired: true }, take: 1 },
        },
      });

      return rows.map((row) => {
        const marks: Partial<Record<MarkerKey, string>> = {};
        for (const event of row.systemEvents) {
          const key = (Object.keys(EVENT_MARKERS) as MarkerKey[]).find(
            (candidate) => EVENT_MARKERS[candidate] === event.type,
          );
          // First occurrence wins: the log is ordered, so this is the onset time.
          if (key && marks[key] === undefined) marks[key] = event.recordedAt.toISOString();
        }
        const createdAt = row.createdAt.toISOString();
        const assigned = marks.assigned ?? null;
        const onboard = marks.onboard ?? null;
        const arrivedHospital = marks.arrivedHospital ?? null;
        const completedAt = marks.completed ?? (row.status === 'COMPLETED' ? row.updatedAt.toISOString() : null);

        return {
          emergencyId: row.id,
          createdAt,
          completedAt,
          status: row.status,
          incidentType: row.incidentType,
          severity: row.severity,
          isSimulation: row.isSimulation,
          responseTimeMin: diffMin(assigned, marks.arrivedScene ?? null),
          dispatchTimeMin: diffMin(assigned, marks.dispatched ?? null),
          ambulanceTravelMin: diffMin(marks.dispatched ?? null, marks.arrivedScene ?? null),
          transportTimeMin: diffMin(onboard, arrivedHospital),
          totalDurationMin: diffMin(createdAt, arrivedHospital ?? completedAt),
          hospitalId: row.selectedHospitalId,
          ambulanceId: row.assignedAmbulanceId,
          protocolId: row.protocolSessions[0]?.protocolId ?? null,
          escalationRequired: row.protocolSessions[0]?.escalationRequired ?? false,
        };
      });
    }, 'Failed to derive emergency durations');
  }

  async liveState(includeSimulation: boolean): Promise<{
    emergencies: LiveEmergencyRow[];
    ambulances: LiveAmbulanceRow[];
    corridors: LiveCorridorRow[];
  }> {
    return guardDatabase(async () => {
      const [emergencyRows, ambulanceRows, corridorRows] = await Promise.all([
        this.db.emergency.findMany({
          where: {
            isSimulation: includeSimulation ? undefined : false,
            status: { notIn: ['COMPLETED', 'CANCELLED'] },
          },
          orderBy: { createdAt: 'asc' },
          take: 200,
          select: {
            id: true,
            status: true,
            incidentType: true,
            severity: true,
            latitude: true,
            longitude: true,
            createdAt: true,
            assignedAmbulanceId: true,
            selectedHospitalId: true,
            isSimulation: true,
          },
        }),
        this.db.ambulance.findMany({
          where: includeSimulation ? undefined : { isSimulation: false },
          orderBy: { vehicleNumber: 'asc' },
          select: {
            id: true,
            vehicleNumber: true,
            status: true,
            latitude: true,
            longitude: true,
            lastLocationUpdate: true,
            currentEmergencyId: true,
            isSimulation: true,
            equipmentJson: true,
            _count: { select: { crew: true } },
          },
        }),
        this.db.corridor.findMany({
          where: { isActive: true, ...(includeSimulation ? {} : { isSimulation: false }) },
          select: {
            id: true,
            emergencyId: true,
            ambulanceId: true,
            hospitalId: true,
            fromLabel: true,
            toLabel: true,
            estimatedMinutes: true,
            activatedAt: true,
            isSimulation: true,
          },
        }),
      ]);

      return {
        emergencies: emergencyRows.map((row) => ({
          id: row.id,
          status: row.status,
          incidentType: row.incidentType,
          severity: row.severity,
          latitude: row.latitude,
          longitude: row.longitude,
          createdAt: row.createdAt.toISOString(),
          assignedAmbulanceId: row.assignedAmbulanceId,
          selectedHospitalId: row.selectedHospitalId,
          isSimulation: row.isSimulation,
        })),
        ambulances: ambulanceRows.map((row) => ({
          id: row.id,
          vehicleNumber: row.vehicleNumber,
          status: row.status,
          latitude: row.latitude,
          longitude: row.longitude,
          lastLocationUpdate: row.lastLocationUpdate?.toISOString() ?? null,
          currentEmergencyId: row.currentEmergencyId,
          isSimulation: row.isSimulation,
          crewCount: row._count.crew,
          equipment: parseJsonColumn<string[]>(row.equipmentJson, []),
        })),
        corridors: corridorRows.map((row) => ({
          id: row.id,
          emergencyId: row.emergencyId,
          ambulanceId: row.ambulanceId,
          hospitalId: row.hospitalId,
          fromLabel: row.fromLabel,
          toLabel: row.toLabel,
          estimatedMinutes: row.estimatedMinutes,
          activatedAt: row.activatedAt.toISOString(),
          isSimulation: row.isSimulation,
        })),
      };
    }, 'Failed to read live state');
  }

  async eventBreakdown(
    windowDays: number,
    includeSimulation: boolean,
  ): Promise<Array<{ type: string; count: number; latestAt: string }>> {
    return guardDatabase(async () => {
      const since = new Date(Date.now() - windowDays * 86400000);
      const rows = await this.db.systemEvent.findMany({
        where: { recordedAt: { gte: since } },
        orderBy: { recordedAt: 'desc' },
        take: 5000,
        select: { type: true, recordedAt: true, emergencyId: true },
      });
      const emergencyIds = new Set(rows.map((r) => r.emergencyId).filter((id): id is string => Boolean(id)));
      const simulationEmergencies = new Set<string>();
      if (!includeSimulation && emergencyIds.size > 0) {
        const sims = await this.db.emergency.findMany({
          where: { id: { in: [...emergencyIds] }, isSimulation: true },
          select: { id: true },
        });
        sims.forEach((s) => simulationEmergencies.add(s.id));
      }

      const counts = new Map<string, { count: number; latestAt: string }>();
      for (const row of rows) {
        if (row.emergencyId && simulationEmergencies.has(row.emergencyId)) continue;
        const entry = counts.get(row.type);
        const at = row.recordedAt.toISOString();
        if (entry) {
          entry.count += 1;
          if (at > entry.latestAt) entry.latestAt = at;
        } else {
          counts.set(row.type, { count: 1, latestAt: at });
        }
      }
      return [...counts.entries()]
        .map(([type, value]) => ({ type, ...value }))
        .sort((a, b) => b.count - a.count);
    }, 'Failed to aggregate event breakdown');
  }

  async learningSamples(options: {
    windowDays: number;
    includeSimulation: boolean;
  }): Promise<LearningSampleRow[]> {
    return guardDatabase(async () => {
      const since = new Date(Date.now() - options.windowDays * 86400000);
      const rows = await this.db.learningSample.findMany({
        where: {
          recordedAt: { gte: since },
          ...(options.includeSimulation ? {} : { emergency: { isSimulation: false } }),
        },
        orderBy: { recordedAt: 'desc' },
        take: 2000,
        select: {
          emergencyId: true,
          emergencyType: true,
          severity: true,
          responseTimeMin: true,
          dispatchTimeMin: true,
          ambulanceDistanceKm: true,
          hospitalDistanceKm: true,
          protocolUsed: true,
          protocolVersion: true,
          escalationRequired: true,
          routeDurationMin: true,
          transportTimeMin: true,
          totalDurationMin: true,
          outcomeStatus: true,
          survivalToDischarge: true,
          featuresJson: true,
          provenance: true,
          recordedAt: true,
          emergency: { select: { isSimulation: true } },
        },
      });
      return rows.map((row) => ({
        emergencyId: row.emergencyId,
        emergencyType: row.emergencyType,
        severity: row.severity,
        responseTimeMin: row.responseTimeMin,
        dispatchTimeMin: row.dispatchTimeMin,
        ambulanceDistanceKm: row.ambulanceDistanceKm,
        hospitalDistanceKm: row.hospitalDistanceKm,
        protocolUsed: row.protocolUsed,
        protocolVersion: row.protocolVersion,
        escalationRequired: row.escalationRequired,
        routeDurationMin: row.routeDurationMin,
        transportTimeMin: row.transportTimeMin,
        totalDurationMin: row.totalDurationMin,
        outcomeStatus: row.outcomeStatus,
        survivalToDischarge: row.survivalToDischarge,
        features: parseRecord(row.featuresJson),
        provenance: row.provenance,
        recordedAt: row.recordedAt.toISOString(),
        isSimulation: row.emergency.isSimulation,
      }));
    }, 'Failed to read learning samples');
  }

  async insertLearningSample(input: {
    emergencyId: string;
    hospitalId?: string | null;
    emergencyType: string;
    severity: string;
    responseTimeMin?: number | null;
    dispatchTimeMin?: number | null;
    ambulanceDistanceKm?: number | null;
    hospitalDistanceKm?: number | null;
    protocolUsed?: string | null;
    protocolVersion?: string | null;
    escalationRequired: boolean;
    routeDurationMin?: number | null;
    transportTimeMin?: number | null;
    totalDurationMin?: number | null;
    outcomeStatus: string;
    survivalToDischarge?: boolean | null;
    features: Record<string, unknown>;
    provenance: string;
  }): Promise<void> {
    await guardDatabase(
      async () => {
        await this.db.learningSample.upsert({
          where: { emergencyId: input.emergencyId },
          // Both branches must name the mapped columns explicitly. Spreading
          // `input` here passed `features`, which is not a column on the model
          // (it is `featuresJson`), so every first-time insert failed with
          // "Unknown argument `features`" and only the update path ever worked.
          create: {
            id: `LS-${input.emergencyId}`,
            emergencyId: input.emergencyId,
            hospitalId: input.hospitalId ?? null,
            emergencyType: input.emergencyType,
            severity: input.severity,
            responseTimeMin: input.responseTimeMin ?? null,
            dispatchTimeMin: input.dispatchTimeMin ?? null,
            ambulanceDistanceKm: input.ambulanceDistanceKm ?? null,
            hospitalDistanceKm: input.hospitalDistanceKm ?? null,
            protocolUsed: input.protocolUsed ?? null,
            protocolVersion: input.protocolVersion ?? null,
            escalationRequired: input.escalationRequired,
            routeDurationMin: input.routeDurationMin ?? null,
            transportTimeMin: input.transportTimeMin ?? null,
            totalDurationMin: input.totalDurationMin ?? null,
            outcomeStatus: input.outcomeStatus,
            survivalToDischarge: input.survivalToDischarge ?? null,
            featuresJson: JSON.stringify(input.features),
            provenance: input.provenance,
            recordedAt: new Date(),
          },
          update: {
            emergencyType: input.emergencyType,
            severity: input.severity,
            responseTimeMin: input.responseTimeMin ?? null,
            dispatchTimeMin: input.dispatchTimeMin ?? null,
            ambulanceDistanceKm: input.ambulanceDistanceKm ?? null,
            hospitalDistanceKm: input.hospitalDistanceKm ?? null,
            protocolUsed: input.protocolUsed ?? null,
            protocolVersion: input.protocolVersion ?? null,
            escalationRequired: input.escalationRequired,
            routeDurationMin: input.routeDurationMin ?? null,
            transportTimeMin: input.transportTimeMin ?? null,
            totalDurationMin: input.totalDurationMin ?? null,
            outcomeStatus: input.outcomeStatus,
            survivalToDischarge: input.survivalToDischarge ?? null,
            featuresJson: JSON.stringify(input.features),
            provenance: input.provenance,
            recordedAt: new Date(),
          },
        });
      },
      'Failed to store learning sample',
    );
  }

  async modelVersions(limit = 10) {
    return guardDatabase(
      async () =>
        this.db.learningModelVersion.findMany({
          orderBy: { version: 'desc' },
          take: limit,
        }),
      'Failed to read model versions',
    );
  }

  async insertModelVersion(input: {
    version: number;
    samples: number;
    priorAlpha: number;
    priorBeta: number;
    posterior: Record<string, number>;
    strata: Record<string, unknown>;
    method: string;
    note?: string | null;
  }): Promise<void> {
    await guardDatabase(
      async () => {
        const existing = await this.db.learningModelVersion.findUnique({ where: { version: input.version } });
        if (existing) return;
        await this.db.learningModelVersion.create({
          data: {
            id: `LMV-${input.version}`,
            version: input.version,
            samples: input.samples,
            priorAlpha: input.priorAlpha,
            priorBeta: input.priorBeta,
            posteriorJson: JSON.stringify(input.posterior),
            strataJson: JSON.stringify(input.strata),
            method: input.method,
            note: input.note ?? null,
          },
        });
      },
      'Failed to store model version',
    );
  }

  async saveSnapshot(input: { windowDays: number; metrics: unknown; sampleSize: number }): Promise<string> {
    const id = `SNP-${Date.now()}`;
    await guardDatabase(
      async () => {
        await this.db.analyticsSnapshot.create({
          data: {
            id,
            windowDays: input.windowDays,
            metricsJson: JSON.stringify(input.metrics),
            sampleSize: input.sampleSize,
          },
        });
      },
      'Failed to store analytics snapshot',
    );
    return id;
  }

  async snapshotSeries(days: number) {
    return guardDatabase(
      async () =>
        this.db.analyticsSnapshot.findMany({
          where: { computedAt: { gte: new Date(Date.now() - days * 86400000) } },
          orderBy: { computedAt: 'asc' },
          take: 200,
        }),
      'Failed to read snapshot series',
    );
  }
}
