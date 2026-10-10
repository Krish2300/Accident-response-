-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ambulances" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vehicleNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "latitude" REAL,
    "longitude" REAL,
    "lastLocationUpdate" DATETIME,
    "currentEmergencyId" TEXT,
    "assignedAt" DATETIME,
    "availableAt" DATETIME,
    "equipmentJson" TEXT NOT NULL DEFAULT '[]',
    "stationName" TEXT,
    "isSimulation" BOOLEAN NOT NULL DEFAULT false,
    "assignedDriverId" TEXT,
    "simulatedSpeedKmh" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ambulances_currentEmergencyId_fkey" FOREIGN KEY ("currentEmergencyId") REFERENCES "emergencies" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ambulances_assignedDriverId_fkey" FOREIGN KEY ("assignedDriverId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ambulances" ("assignedAt", "availableAt", "createdAt", "currentEmergencyId", "equipmentJson", "id", "isSimulation", "lastLocationUpdate", "latitude", "longitude", "simulatedSpeedKmh", "stationName", "status", "updatedAt", "vehicleNumber") SELECT "assignedAt", "availableAt", "createdAt", "currentEmergencyId", "equipmentJson", "id", "isSimulation", "lastLocationUpdate", "latitude", "longitude", "simulatedSpeedKmh", "stationName", "status", "updatedAt", "vehicleNumber" FROM "ambulances";
DROP TABLE "ambulances";
ALTER TABLE "new_ambulances" RENAME TO "ambulances";
CREATE UNIQUE INDEX "ambulances_vehicleNumber_key" ON "ambulances"("vehicleNumber");
CREATE INDEX "ambulances_status_idx" ON "ambulances"("status");
CREATE INDEX "ambulances_isSimulation_status_idx" ON "ambulances"("isSimulation", "status");
CREATE INDEX "ambulances_currentEmergencyId_idx" ON "ambulances"("currentEmergencyId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
