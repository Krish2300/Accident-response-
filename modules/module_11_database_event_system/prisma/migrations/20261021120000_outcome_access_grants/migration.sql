-- Explicit, revocable per-emergency outcome access grants (Stage 4.26).
-- Grants replace the implicit operational relationships that Stage 4.25 used
-- as scope evidence; the append-only assertion and review history semantics
-- are unchanged. One row per (emergency, grantee, capability); revocation
-- stamps the existing row instead of deleting audit state.
CREATE TABLE "emergency_outcome_grants" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "emergencyId" TEXT NOT NULL,
    "granteeUserId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    "revokedByUserId" TEXT,
    "revokeReason" TEXT,
    CONSTRAINT "emergency_outcome_grants_emergencyId_granteeUserId_capability_key" UNIQUE ("emergencyId", "granteeUserId", "capability"),
    CONSTRAINT "emergency_outcome_grants_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "emergencies" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "emergency_outcome_grants_granteeUserId_fkey" FOREIGN KEY ("granteeUserId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "emergency_outcome_grants_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "emergency_outcome_grants_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "emergency_outcome_grants_capability_check" CHECK ("capability" IN ('SUBMIT', 'REVIEW'))
);

CREATE INDEX "emergency_outcome_grants_emergencyId_idx" ON "emergency_outcome_grants"("emergencyId");
CREATE INDEX "emergency_outcome_grants_granteeUserId_idx" ON "emergency_outcome_grants"("granteeUserId");
