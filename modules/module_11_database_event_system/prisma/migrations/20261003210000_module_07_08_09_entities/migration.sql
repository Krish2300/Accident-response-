-- Module 11 migration: entities required by modules 7, 8 and 9.
--
-- Adds:
--   hospital_resources - live ICU / ED / specialist / equipment availability
--                        that Module 7 scores hospitals against. A Hospital row
--                        says what a hospital is; these rows say what it has now.
--   patients            - the triage-relevant facts assembled from the call by
--                        modules 3 and 4. Deliberately no identity fields.
--   notifications       - module 9 corridor alerts, recording intent and whether
--                        a message was actually delivered by a real provider.
--   corridors            - + status, priorityMode, radiusM, geofenceJson,
--                        roadUsersJson, signalsJson, renegotiationCount
--   routes               - + provider, isLiveTraffic, trafficFactor,
--                        alternativesJson, selectionReasonJson, recalculationCount
--
-- The corridors and routes changes are table redefinitions because SQLite cannot
-- add columns in place. Both preserve existing rows via INSERT ... SELECT.
-- CreateTable
CREATE TABLE "hospital_resources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hospitalId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "code" TEXT NOT NULL DEFAULT '',
    "total" INTEGER NOT NULL DEFAULT 0,
    "available" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "hospital_resources_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "hospitals" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "patients" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "emergencyId" TEXT NOT NULL,
    "patientCount" INTEGER NOT NULL DEFAULT 1,
    "ageGroup" TEXT,
    "sex" TEXT,
    "consciousness" TEXT,
    "breathing" TEXT,
    "symptomsJson" TEXT NOT NULL DEFAULT '[]',
    "locationText" TEXT,
    "address" TEXT,
    "missingFactsJson" TEXT NOT NULL DEFAULT '[]',
    "factSourcesJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "patients_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "emergencies" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "emergencyId" TEXT NOT NULL,
    "corridorId" TEXT,
    "channel" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "latitude" REAL,
    "longitude" REAL,
    "failureReason" TEXT,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "emergencies" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_corridors" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "emergencyId" TEXT NOT NULL,
    "ambulanceId" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "fromLabel" TEXT NOT NULL,
    "toLabel" TEXT NOT NULL,
    "estimatedMinutes" REAL NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "activatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" DATETIME,
    "isSimulation" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "priorityMode" TEXT NOT NULL DEFAULT 'SIMULATED',
    "radiusM" REAL NOT NULL DEFAULT 150,
    "geofenceJson" TEXT NOT NULL DEFAULT '[]',
    "roadUsersJson" TEXT NOT NULL DEFAULT '[]',
    "signalsJson" TEXT NOT NULL DEFAULT '[]',
    "renegotiationCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "corridors_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "emergencies" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "corridors_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "hospitals" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_corridors" ("activatedAt", "ambulanceId", "emergencyId", "estimatedMinutes", "fromLabel", "hospitalId", "id", "isActive", "isSimulation", "releasedAt", "toLabel") SELECT "activatedAt", "ambulanceId", "emergencyId", "estimatedMinutes", "fromLabel", "hospitalId", "id", "isActive", "isSimulation", "releasedAt", "toLabel" FROM "corridors";
DROP TABLE "corridors";
ALTER TABLE "new_corridors" RENAME TO "corridors";
CREATE UNIQUE INDEX "corridors_emergencyId_key" ON "corridors"("emergencyId");
CREATE INDEX "corridors_isActive_idx" ON "corridors"("isActive");
CREATE INDEX "corridors_status_idx" ON "corridors"("status");
CREATE TABLE "new_routes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "emergencyId" TEXT NOT NULL,
    "ambulanceId" TEXT NOT NULL,
    "hospitalId" TEXT,
    "originName" TEXT NOT NULL DEFAULT 'INCIDENT',
    "destinationName" TEXT NOT NULL DEFAULT 'SCENE',
    "originLat" REAL NOT NULL,
    "originLng" REAL NOT NULL,
    "destLat" REAL NOT NULL,
    "destLng" REAL NOT NULL,
    "distanceKm" REAL NOT NULL,
    "polylineJson" TEXT NOT NULL DEFAULT '[]',
    "progressPct" REAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "estimatedMinutes" REAL,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "isSimulation" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "isLiveTraffic" BOOLEAN NOT NULL DEFAULT false,
    "trafficFactor" REAL,
    "alternativesJson" TEXT NOT NULL DEFAULT '[]',
    "selectionReasonJson" TEXT NOT NULL DEFAULT '{}',
    "recalculationCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "routes_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "emergencies" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "routes_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "hospitals" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_routes" ("ambulanceId", "completedAt", "createdAt", "destLat", "destLng", "destinationName", "distanceKm", "emergencyId", "estimatedMinutes", "hospitalId", "id", "isSimulation", "originLat", "originLng", "originName", "polylineJson", "progressPct", "startedAt", "status", "updatedAt") SELECT "ambulanceId", "completedAt", "createdAt", "destLat", "destLng", "destinationName", "distanceKm", "emergencyId", "estimatedMinutes", "hospitalId", "id", "isSimulation", "originLat", "originLng", "originName", "polylineJson", "progressPct", "startedAt", "status", "updatedAt" FROM "routes";
DROP TABLE "routes";
ALTER TABLE "new_routes" RENAME TO "routes";
CREATE INDEX "routes_emergencyId_idx" ON "routes"("emergencyId");
CREATE INDEX "routes_hospitalId_idx" ON "routes"("hospitalId");
CREATE INDEX "routes_status_idx" ON "routes"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "hospital_resources_hospitalId_resourceType_idx" ON "hospital_resources"("hospitalId", "resourceType");

-- CreateIndex
CREATE UNIQUE INDEX "hospital_resources_hospitalId_resourceType_code_key" ON "hospital_resources"("hospitalId", "resourceType", "code");

-- CreateIndex
CREATE UNIQUE INDEX "patients_emergencyId_key" ON "patients"("emergencyId");

-- CreateIndex
CREATE INDEX "patients_consciousness_idx" ON "patients"("consciousness");

-- CreateIndex
CREATE INDEX "notifications_emergencyId_idx" ON "notifications"("emergencyId");

-- CreateIndex
CREATE INDEX "notifications_status_idx" ON "notifications"("status");

-- CreateIndex
CREATE UNIQUE INDEX "learning_model_versions_version_key" ON "learning_model_versions"("version");


