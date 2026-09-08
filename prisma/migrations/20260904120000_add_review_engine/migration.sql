-- Phase 003 review-engine persistence. Raw diffs, prompts, provider bodies,
-- request headers, keys, and temporary paths deliberately have no columns.

ALTER TYPE "public"."JobStatus" ADD VALUE IF NOT EXISTS 'PARTIAL';

CREATE TYPE "public"."FindingSeverity" AS ENUM ('Critical', 'High', 'Medium', 'Low');
CREATE TYPE "public"."EngineKind" AS ENUM ('STATIC', 'AI');
CREATE TYPE "public"."EngineRunOutcome" AS ENUM ('SUCCEEDED', 'PARTIAL', 'FAILED', 'TIMED_OUT', 'INVALID');

ALTER TABLE "public"."FoundationJob"
  ADD COLUMN "changedLineCount" INTEGER,
  ADD COLUMN "reviewDurationMs" INTEGER,
  ADD COLUMN "outsideLatencyCohort" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "public"."Finding"
  ADD COLUMN "filePath" TEXT NOT NULL,
  ADD COLUMN "startLine" INTEGER NOT NULL,
  ADD COLUMN "endLine" INTEGER NOT NULL,
  ADD COLUMN "severity" "public"."FindingSeverity" NOT NULL,
  ADD COLUMN "category" TEXT NOT NULL,
  ADD COLUMN "fingerprint" TEXT NOT NULL,
  ADD COLUMN "summary" TEXT NOT NULL,
  ADD COLUMN "reasoning" TEXT NOT NULL,
  ADD COLUMN "snippet" TEXT NOT NULL;

CREATE TABLE "public"."FindingProvenance" (
  "id" TEXT NOT NULL,
  "findingId" TEXT NOT NULL,
  "engineKind" "public"."EngineKind" NOT NULL,
  "engineIdentifier" TEXT NOT NULL,
  "staticRuleId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FindingProvenance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."EngineRun" (
  "id" TEXT NOT NULL,
  "foundationJobId" TEXT NOT NULL,
  "engineKind" "public"."EngineKind" NOT NULL,
  "engineIdentifier" TEXT NOT NULL,
  "outcome" "public"."EngineRunOutcome" NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "findingCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EngineRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Finding_foundationJobId_fingerprint_key" ON "public"."Finding"("foundationJobId", "fingerprint");
CREATE INDEX "Finding_foundationJobId_severity_idx" ON "public"."Finding"("foundationJobId", "severity");
CREATE UNIQUE INDEX "FindingProvenance_findingId_engineKind_engineIdentifier_staticRuleId_key" ON "public"."FindingProvenance"("findingId", "engineKind", "engineIdentifier", "staticRuleId");
CREATE UNIQUE INDEX "EngineRun_foundationJobId_engineIdentifier_key" ON "public"."EngineRun"("foundationJobId", "engineIdentifier");
CREATE INDEX "EngineRun_foundationJobId_engineKind_idx" ON "public"."EngineRun"("foundationJobId", "engineKind");

ALTER TABLE "public"."FindingProvenance" ADD CONSTRAINT "FindingProvenance_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "public"."Finding"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."EngineRun" ADD CONSTRAINT "EngineRun_foundationJobId_fkey" FOREIGN KEY ("foundationJobId") REFERENCES "public"."FoundationJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
