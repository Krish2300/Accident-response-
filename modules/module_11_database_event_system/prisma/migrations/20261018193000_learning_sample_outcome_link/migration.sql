-- Link a stored learning sample to the exact assertion that passed the
-- current-review eligibility gate. Legacy samples remain unlinked and cannot
-- be treated as operational learning observations.
ALTER TABLE "learning_samples"
ADD COLUMN "outcomeAssertionId" TEXT REFERENCES "outcome_assertions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "learning_samples_outcomeAssertionId_idx"
ON "learning_samples"("outcomeAssertionId");
