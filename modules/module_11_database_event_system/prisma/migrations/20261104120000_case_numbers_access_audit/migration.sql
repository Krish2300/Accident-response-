-- Case numbers for every emergency + an append-only access audit.
-- AlterTable
ALTER TABLE "emergencies" ADD COLUMN "caseNumber" TEXT;

-- CreateTable
CREATE TABLE "access_audit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "userEmail" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "emergencyId" TEXT,
    "caseNumber" TEXT,
    "ipAddress" TEXT,
    "detail" TEXT
);

-- CreateIndex
CREATE INDEX "access_audit_emergencyId_idx" ON "access_audit"("emergencyId");

-- CreateIndex
CREATE INDEX "access_audit_userId_idx" ON "access_audit"("userId");

-- CreateIndex
CREATE INDEX "access_audit_at_idx" ON "access_audit"("at");

-- CreateIndex
CREATE UNIQUE INDEX "emergencies_caseNumber_key" ON "emergencies"("caseNumber");

-- Append-only: an access record can never be altered or removed.
CREATE TRIGGER "access_audit_no_update" BEFORE UPDATE ON "access_audit"
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_RECORD: access_audit is append-only'); END;
CREATE TRIGGER "access_audit_no_delete" BEFORE DELETE ON "access_audit"
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_RECORD: access_audit is append-only'); END;
