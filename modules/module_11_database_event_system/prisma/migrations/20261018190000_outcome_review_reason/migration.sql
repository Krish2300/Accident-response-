-- Store constrained rationale for a review decision separately from the
-- eligibility rationale. Existing append-only review rows remain unchanged.
ALTER TABLE "outcome_reviews" ADD COLUMN "reviewReasonCode" TEXT;
