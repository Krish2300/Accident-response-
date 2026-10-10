import { AppError, type AmbulanceLocation, type Logger, noopLogger } from '@resus/core';
import type { FleetService } from '../fleetService.js';

export interface TrackingServiceDeps {
  fleet: FleetService;
  logger?: Logger;
}

export class TrackingService {
  private readonly fleet: FleetService;
  private readonly logger: Logger;

  constructor(deps: TrackingServiceDeps) {
    this.fleet = deps.fleet;
    this.logger = deps.logger ?? noopLogger;
  }

  async updateLocation(input: {
    ambulanceId: string;
    latitude: number;
    longitude: number;
    speedKmh?: number | null;
    headingDeg?: number | null;
    accuracyM?: number | null;
    source?: string;
    isSimulation?: boolean;
  }): Promise<AmbulanceLocation> {
    try {
      return await this.fleet.recordLocation(input);
    } catch (error) {
      this.logger.error({ error, ambulanceId: input.ambulanceId }, 'Failed to update ambulance location');
      throw error;
    }
  }

  async getLatestLocation(ambulanceId: string): Promise<AmbulanceLocation | null> {
    return this.fleet.getLatestLocation(ambulanceId);
  }

  isLocationFresh(location: AmbulanceLocation | null, maxStaleMinutes: number): boolean {
    if (!location) return false;
    const ageMin = (Date.now() - new Date(location.recordedAt).getTime()) / 60000;
    return ageMin <= maxStaleMinutes;
  }
}
