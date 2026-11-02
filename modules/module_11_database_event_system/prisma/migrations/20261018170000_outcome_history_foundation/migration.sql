-- Additive, append-only outcome assertions and review history. Legacy outcomes
-- remain in `outcomes` and are intentionally not migrated or promoted.
CREATE TABLE "outcome_assertions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "emergencyId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "categoryVersion" TEXT NOT NULL,
    "provenance" TEXT NOT NULL,
    "dataClassification" TEXT NOT NULL,
    "survivalToDischarge" BOOLEAN,
    "observedAt" DATETIME,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedByUserId" TEXT,
    "evidenceRefsJson" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "supersedesOutcomeId" TEXT,
    CONSTRAINT "outcome_assertions_idempotencyKey_key" UNIQUE ("idempotencyKey"),
    CONSTRAINT "outcome_assertions_supersedesOutcomeId_key" UNIQUE ("supersedesOutcomeId"),
    CONSTRAINT "outcome_assertions_emergencyId_id_key" UNIQUE ("emergencyId", "id"),
    CONSTRAINT "outcome_assertions_emergencyId_supersedesOutcomeId_key" UNIQUE ("emergencyId", "supersedesOutcomeId"),
    CONSTRAINT "outcome_assertions_emergencyId_fkey" FOREIGN KEY ("emergencyId") REFERENCES "emergencies" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "outcome_assertions_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "outcome_assertions_predecessor_fkey" FOREIGN KEY ("emergencyId", "supersedesOutcomeId") REFERENCES "outcome_assertions" ("emergencyId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "outcome_assertions_category_check" CHECK ("category" IN ('STABILISED', 'TRANSPORTED', 'SURVIVED_TO_DISCHARGE', 'DECEASED', 'HANDED_OVER_OTHER_SERVICE', 'CANCELLED_BEFORE_ARRIVAL', 'UNKNOWN')),
    CONSTRAINT "outcome_assertions_category_version_check" CHECK ("categoryVersion" = 'OUTCOME_V1'),
    CONSTRAINT "outcome_assertions_provenance_check" CHECK ("provenance" IN ('REAL_OBSERVED', 'SIMULATION', 'STATISTICAL_ESTIMATE', 'MODEL_OUTPUT')),
    CONSTRAINT "outcome_assertions_survival_label_check" CHECK (
      ("category" = 'SURVIVED_TO_DISCHARGE' AND "survivalToDischarge" = 1) OR
      ("category" = 'DECEASED' AND "survivalToDischarge" = 0) OR
      ("category" NOT IN ('SURVIVED_TO_DISCHARGE', 'DECEASED') AND "survivalToDischarge" IS NULL)
    ),
    CONSTRAINT "outcome_assertions_not_self_superseding_check" CHECK ("supersedesOutcomeId" IS NULL OR "supersedesOutcomeId" <> "id"),
    CONSTRAINT "outcome_assertions_data_classification_check" CHECK ("dataClassification" IN ('OPERATIONAL', 'SIMULATION', 'TEST', 'UNVERIFIED_LEGACY'))
);

CREATE INDEX "outcome_assertions_emergencyId_recordedAt_idx" ON "outcome_assertions"("emergencyId", "recordedAt");
CREATE INDEX "outcome_assertions_category_recordedAt_idx" ON "outcome_assertions"("category", "recordedAt");
CREATE INDEX "outcome_assertions_dataClassification_provenance_idx" ON "outcome_assertions"("dataClassification", "provenance");

CREATE TABLE "outcome_reviews" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "outcomeRecordId" TEXT NOT NULL,
    "reviewerUserId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reviewedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eligibleForLearning" BOOLEAN NOT NULL,
    "eligibilityReasonCode" TEXT NOT NULL,
    "evidenceAssessmentJson" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "supersedesReviewId" TEXT,
    CONSTRAINT "outcome_reviews_idempotencyKey_key" UNIQUE ("idempotencyKey"),
    CONSTRAINT "outcome_reviews_supersedesReviewId_key" UNIQUE ("supersedesReviewId"),
    CONSTRAINT "outcome_reviews_outcomeRecordId_id_key" UNIQUE ("outcomeRecordId", "id"),
    CONSTRAINT "outcome_reviews_outcomeRecordId_supersedesReviewId_key" UNIQUE ("outcomeRecordId", "supersedesReviewId"),
    CONSTRAINT "outcome_reviews_decision_check" CHECK ("decision" IN ('APPROVED', 'REJECTED', 'NEEDS_EVIDENCE')),
    CONSTRAINT "outcome_reviews_outcomeRecordId_fkey" FOREIGN KEY ("outcomeRecordId") REFERENCES "outcome_assertions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "outcome_reviews_reviewerUserId_fkey" FOREIGN KEY ("reviewerUserId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "outcome_reviews_predecessor_fkey" FOREIGN KEY ("outcomeRecordId", "supersedesReviewId") REFERENCES "outcome_reviews" ("outcomeRecordId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "outcome_reviews_eligibility_check" CHECK ("eligibleForLearning" = 0 OR "decision" = 'APPROVED'),
    CONSTRAINT "outcome_reviews_not_self_superseding_check" CHECK ("supersedesReviewId" IS NULL OR "supersedesReviewId" <> "id")
);

-- Exactly one initial review per assertion; later decisions explicitly link to
-- the prior review and the unique predecessor constraint prevents branches.
CREATE UNIQUE INDEX "outcome_reviews_one_root_per_outcome_key"
ON "outcome_reviews"("outcomeRecordId") WHERE "supersedesReviewId" IS NULL;
CREATE INDEX "outcome_reviews_outcomeRecordId_reviewedAt_idx" ON "outcome_reviews"("outcomeRecordId", "reviewedAt");
CREATE INDEX "outcome_reviews_reviewerUserId_reviewedAt_idx" ON "outcome_reviews"("reviewerUserId", "reviewedAt");


-- These tables are append-only even when written through another Module 11 path.
CREATE TRIGGER "outcome_assertions_immutable_update"
BEFORE UPDATE ON "outcome_assertions"
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_OUTCOME_ASSERTION');
END;
CREATE TRIGGER "outcome_assertions_immutable_delete"
BEFORE DELETE ON "outcome_assertions"
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_OUTCOME_ASSERTION');
END;
CREATE TRIGGER "outcome_reviews_immutable_update"
BEFORE UPDATE ON "outcome_reviews"
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_OUTCOME_REVIEW');
END;
CREATE TRIGGER "outcome_reviews_immutable_delete"
BEFORE DELETE ON "outcome_reviews"
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_OUTCOME_REVIEW');
END;
