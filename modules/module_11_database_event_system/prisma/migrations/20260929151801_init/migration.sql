-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'OPERATOR',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "emergencies" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "incidentType" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "latitude" REAL NOT NULL,
    "longitude" REAL NOT NULL,
    "description" TEXT,
    "callerId" TEXT,
    "assignedAmbulanceId" TEXT,
    "selectedHospitalId" TEXT,
    "isSimulation" BOOLEAN NOT NULL DEFAULT false,
    "address" TEXT,
    CONSTRAINT "emergencies_assignedAmbulanceId_fkey" FOREIGN KEY ("assignedAmbulanceId") REFERENCES "ambulances" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "emergencies_selectedHospitalId_fkey" FOREIGN KEY ("selectedHospitalId") REFERENCES "hospitals" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "call_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "emergencyId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'VOICE',
    "callerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "language" TEXT NOT NULL DEFAULT 'en',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "isSimulation" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "call_sessions_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "emergencies" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "transcripts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "callSessionId" TEXT NOT NULL,
    "emergencyId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "speaker" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "isFinal" BOOLEAN NOT NULL DEFAULT true,
    "intent" TEXT,
    "confidence" REAL,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isSimulation" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "transcripts_callSessionId_fkey" FOREIGN KEY ("callSessionId") REFERENCES "call_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "transcripts_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "emergencies" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "protocol_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "emergencyId" TEXT NOT NULL,
    "protocolId" TEXT NOT NULL,
    "protocolVersion" TEXT NOT NULL,
    "protocolSource" TEXT NOT NULL,
    "currentStep" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    "escalationRequired" BOOLEAN NOT NULL DEFAULT false,
    "escalationReason" TEXT,
    "clarificationCount" INTEGER NOT NULL DEFAULT 0,
    "collectedFactsJson" TEXT NOT NULL DEFAULT '{}',
    "llmProvider" TEXT NOT NULL DEFAULT 'ollama',
    "llmModel" TEXT NOT NULL DEFAULT 'qwen3:8b',
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "initiatedBy" TEXT NOT NULL DEFAULT 'SYSTEM',
    "initiatedByUserId" TEXT,
    CONSTRAINT "protocol_sessions_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "emergencies" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "protocol_sessions_initiatedByUserId_fkey" FOREIGN KEY ("initiatedByUserId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "protocol_steps" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "protocolSessionId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "presentedAt" DATETIME,
    "completedAt" DATETIME,
    "resultJson" TEXT,
    CONSTRAINT "protocol_steps_protocolSessionId_fkey" FOREIGN KEY ("protocolSessionId") REFERENCES "protocol_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ambulances" (
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
    "simulatedSpeedKmh" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ambulances_currentEmergencyId_fkey" FOREIGN KEY ("currentEmergencyId") REFERENCES "emergencies" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ambulance_crew" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ambulanceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "capabilitiesJson" TEXT NOT NULL DEFAULT '[]',
    "isOnDuty" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "ambulance_crew_ambulanceId_fkey" FOREIGN KEY ("ambulanceId") REFERENCES "ambulances" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ambulance_locations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ambulanceId" TEXT NOT NULL,
    "latitude" REAL NOT NULL,
    "longitude" REAL NOT NULL,
    "speedKmh" REAL,
    "headingDeg" REAL,
    "accuracyM" REAL,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'GPS',
    "isSimulation" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "ambulance_locations_ambulanceId_fkey" FOREIGN KEY ("ambulanceId") REFERENCES "ambulances" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ambulance_assignments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "emergencyId" TEXT NOT NULL,
    "ambulanceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ASSIGNED',
    "source" TEXT NOT NULL DEFAULT 'AUTOMATIC',
    "distanceKm" REAL NOT NULL,
    "estimatedResponseTimeMin" REAL NOT NULL,
    "score" REAL NOT NULL,
    "matchingFactorsJson" TEXT NOT NULL DEFAULT '[]',
    "rejectedReasonsJson" TEXT NOT NULL DEFAULT '{}',
    "overrideReason" TEXT,
    "consideredCandidates" INTEGER NOT NULL DEFAULT 0,
    "decidedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" DATETIME,
    "decidedByUserId" TEXT,
    CONSTRAINT "ambulance_assignments_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "emergencies" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ambulance_assignments_ambulanceId_fkey" FOREIGN KEY ("ambulanceId") REFERENCES "ambulances" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ambulance_assignments_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "hospitals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "latitude" REAL NOT NULL,
    "longitude" REAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "capabilitiesJson" TEXT NOT NULL DEFAULT '[]',
    "traumaLevel" INTEGER NOT NULL DEFAULT 1,
    "acceptingEmergencies" BOOLEAN NOT NULL DEFAULT true,
    "address" TEXT,
    "contactPhone" TEXT,
    "isSimulation" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "routes" (
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
    CONSTRAINT "routes_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "emergencies" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "routes_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "hospitals" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "route_updates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "routeId" TEXT NOT NULL,
    "progressPct" REAL NOT NULL,
    "positionLat" REAL,
    "positionLng" REAL,
    "remainingKm" REAL,
    "note" TEXT,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "route_updates_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "routes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "corridors" (
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
    CONSTRAINT "corridors_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "emergencies" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "corridors_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "hospitals" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "system_events" (
    "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "emergencyId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "metadataJson" TEXT,
    "actorType" TEXT,
    "actorId" TEXT,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "system_events_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "emergencies" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "decisions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "emergencyId" TEXT NOT NULL,
    "decisionType" TEXT NOT NULL,
    "ambulanceId" TEXT,
    "hospitalId" TEXT,
    "optionsConsideredJson" TEXT NOT NULL DEFAULT '[]',
    "chosen" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "actorType" TEXT NOT NULL DEFAULT 'SYSTEM',
    "actorId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "decisions_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "emergencies" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "outcomes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "emergencyId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provenance" TEXT NOT NULL DEFAULT 'REAL_OBSERVED',
    "survivalToDischarge" BOOLEAN,
    "notes" TEXT,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedByUserId" TEXT,
    CONSTRAINT "outcomes_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "emergencies" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "outcomes_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "learning_samples" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "emergencyId" TEXT NOT NULL,
    "hospitalId" TEXT,
    "emergencyType" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "responseTimeMin" REAL,
    "dispatchTimeMin" REAL,
    "ambulanceDistanceKm" REAL,
    "hospitalDistanceKm" REAL,
    "protocolUsed" TEXT,
    "protocolVersion" TEXT,
    "escalationRequired" BOOLEAN NOT NULL DEFAULT false,
    "routeDurationMin" REAL,
    "transportTimeMin" REAL,
    "totalDurationMin" REAL,
    "outcomeStatus" TEXT NOT NULL,
    "survivalToDischarge" BOOLEAN,
    "featuresJson" TEXT NOT NULL DEFAULT '{}',
    "provenance" TEXT NOT NULL DEFAULT 'REAL_OBSERVED',
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "learning_samples_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "emergencies" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "learning_samples_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "hospitals" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "analytics_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "windowDays" INTEGER NOT NULL,
    "metricsJson" TEXT NOT NULL,
    "provenance" TEXT NOT NULL DEFAULT 'STATISTICAL_ESTIMATE',
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "learning_model_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" INTEGER NOT NULL,
    "samples" INTEGER NOT NULL DEFAULT 0,
    "priorAlpha" REAL NOT NULL,
    "priorBeta" REAL NOT NULL,
    "posteriorJson" TEXT NOT NULL DEFAULT '{}',
    "strataJson" TEXT NOT NULL DEFAULT '{}',
    "method" TEXT NOT NULL DEFAULT 'bayesian-dirichlet-laplace',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "emergencies_status_idx" ON "emergencies"("status");

-- CreateIndex
CREATE INDEX "emergencies_severity_idx" ON "emergencies"("severity");

-- CreateIndex
CREATE INDEX "emergencies_incidentType_idx" ON "emergencies"("incidentType");

-- CreateIndex
CREATE INDEX "emergencies_createdAt_idx" ON "emergencies"("createdAt");

-- CreateIndex
CREATE INDEX "emergencies_isSimulation_status_idx" ON "emergencies"("isSimulation", "status");

-- CreateIndex
CREATE INDEX "call_sessions_emergencyId_idx" ON "call_sessions"("emergencyId");

-- CreateIndex
CREATE INDEX "call_sessions_startedAt_idx" ON "call_sessions"("startedAt");

-- CreateIndex
CREATE INDEX "transcripts_emergencyId_sequence_idx" ON "transcripts"("emergencyId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "transcripts_callSessionId_sequence_key" ON "transcripts"("callSessionId", "sequence");

-- CreateIndex
CREATE INDEX "protocol_sessions_emergencyId_idx" ON "protocol_sessions"("emergencyId");

-- CreateIndex
CREATE INDEX "protocol_sessions_status_idx" ON "protocol_sessions"("status");

-- CreateIndex
CREATE INDEX "protocol_steps_protocolSessionId_orderIndex_idx" ON "protocol_steps"("protocolSessionId", "orderIndex");

-- CreateIndex
CREATE UNIQUE INDEX "protocol_steps_protocolSessionId_stepId_key" ON "protocol_steps"("protocolSessionId", "stepId");

-- CreateIndex
CREATE UNIQUE INDEX "ambulances_vehicleNumber_key" ON "ambulances"("vehicleNumber");

-- CreateIndex
CREATE INDEX "ambulances_status_idx" ON "ambulances"("status");

-- CreateIndex
CREATE INDEX "ambulances_isSimulation_status_idx" ON "ambulances"("isSimulation", "status");

-- CreateIndex
CREATE INDEX "ambulances_currentEmergencyId_idx" ON "ambulances"("currentEmergencyId");

-- CreateIndex
CREATE INDEX "ambulance_crew_ambulanceId_idx" ON "ambulance_crew"("ambulanceId");

-- CreateIndex
CREATE INDEX "ambulance_locations_ambulanceId_recordedAt_idx" ON "ambulance_locations"("ambulanceId", "recordedAt");

-- CreateIndex
CREATE INDEX "ambulance_assignments_emergencyId_idx" ON "ambulance_assignments"("emergencyId");

-- CreateIndex
CREATE INDEX "ambulance_assignments_ambulanceId_idx" ON "ambulance_assignments"("ambulanceId");

-- CreateIndex
CREATE INDEX "ambulance_assignments_status_idx" ON "ambulance_assignments"("status");

-- CreateIndex
CREATE INDEX "hospitals_status_idx" ON "hospitals"("status");

-- CreateIndex
CREATE INDEX "routes_emergencyId_idx" ON "routes"("emergencyId");

-- CreateIndex
CREATE INDEX "routes_hospitalId_idx" ON "routes"("hospitalId");

-- CreateIndex
CREATE INDEX "route_updates_routeId_recordedAt_idx" ON "route_updates"("routeId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "corridors_emergencyId_key" ON "corridors"("emergencyId");

-- CreateIndex
CREATE INDEX "corridors_isActive_idx" ON "corridors"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "system_events_id_key" ON "system_events"("id");

-- CreateIndex
CREATE INDEX "system_events_emergencyId_seq_idx" ON "system_events"("emergencyId", "seq");

-- CreateIndex
CREATE INDEX "system_events_type_seq_idx" ON "system_events"("type", "seq");

-- CreateIndex
CREATE INDEX "system_events_recordedAt_idx" ON "system_events"("recordedAt");

-- CreateIndex
CREATE INDEX "system_events_entityId_idx" ON "system_events"("entityId");

-- CreateIndex
CREATE INDEX "decisions_emergencyId_createdAt_idx" ON "decisions"("emergencyId", "createdAt");

-- CreateIndex
CREATE INDEX "decisions_decisionType_idx" ON "decisions"("decisionType");

-- CreateIndex
CREATE UNIQUE INDEX "outcomes_emergencyId_key" ON "outcomes"("emergencyId");

-- CreateIndex
CREATE INDEX "outcomes_status_idx" ON "outcomes"("status");

-- CreateIndex
CREATE UNIQUE INDEX "learning_samples_emergencyId_key" ON "learning_samples"("emergencyId");

-- CreateIndex
CREATE INDEX "learning_samples_emergencyType_recordedAt_idx" ON "learning_samples"("emergencyType", "recordedAt");

-- CreateIndex
CREATE INDEX "learning_samples_provenance_idx" ON "learning_samples"("provenance");

-- CreateIndex
CREATE INDEX "analytics_snapshots_computedAt_idx" ON "analytics_snapshots"("computedAt");

-- CreateIndex
CREATE INDEX "learning_model_versions_version_idx" ON "learning_model_versions"("version");
