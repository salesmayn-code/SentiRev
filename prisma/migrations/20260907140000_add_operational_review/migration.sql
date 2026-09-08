-- Phase 004 operational review records. These tables retain lifecycle and
-- delivery state only; raw diffs, provider bodies, credentials, and headers
-- remain outside durable storage.

-- CreateEnum
CREATE TYPE "public"."ReviewFeedbackKind" AS ENUM ('FINDING', 'NO_FINDINGS', 'DELAYED', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."ReviewFeedbackStatus" AS ENUM ('PENDING', 'POSTED', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."ReviewRetryStatus" AS ENUM ('REQUESTED', 'QUEUED', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "public"."FindingDismissal" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "dismissedById" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),
    "undoneById" TEXT,

    CONSTRAINT "FindingDismissal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ReviewCommentDelivery" (
    "id" TEXT NOT NULL,
    "foundationJobId" TEXT NOT NULL,
    "findingId" TEXT,
    "kind" "public"."ReviewFeedbackKind" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "public"."ReviewFeedbackStatus" NOT NULL DEFAULT 'PENDING',
    "githubCommentId" TEXT,
    "postedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewCommentDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ReviewRetryRequest" (
    "id" TEXT NOT NULL,
    "foundationJobId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "public"."ReviewRetryStatus" NOT NULL DEFAULT 'REQUESTED',
    "errorCode" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewRetryRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FindingDismissal_findingId_undoneAt_dismissedAt_idx" ON "public"."FindingDismissal"("findingId", "undoneAt", "dismissedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewCommentDelivery_idempotencyKey_key" ON "public"."ReviewCommentDelivery"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ReviewCommentDelivery_foundationJobId_status_idx" ON "public"."ReviewCommentDelivery"("foundationJobId", "status");

-- CreateIndex
CREATE INDEX "ReviewCommentDelivery_findingId_status_idx" ON "public"."ReviewCommentDelivery"("findingId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewRetryRequest_idempotencyKey_key" ON "public"."ReviewRetryRequest"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ReviewRetryRequest_foundationJobId_status_idx" ON "public"."ReviewRetryRequest"("foundationJobId", "status");

-- AddForeignKey
ALTER TABLE "public"."FindingDismissal" ADD CONSTRAINT "FindingDismissal_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "public"."Finding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FindingDismissal" ADD CONSTRAINT "FindingDismissal_dismissedById_fkey" FOREIGN KEY ("dismissedById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FindingDismissal" ADD CONSTRAINT "FindingDismissal_undoneById_fkey" FOREIGN KEY ("undoneById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReviewCommentDelivery" ADD CONSTRAINT "ReviewCommentDelivery_foundationJobId_fkey" FOREIGN KEY ("foundationJobId") REFERENCES "public"."FoundationJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReviewCommentDelivery" ADD CONSTRAINT "ReviewCommentDelivery_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "public"."Finding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReviewRetryRequest" ADD CONSTRAINT "ReviewRetryRequest_foundationJobId_fkey" FOREIGN KEY ("foundationJobId") REFERENCES "public"."FoundationJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReviewRetryRequest" ADD CONSTRAINT "ReviewRetryRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
