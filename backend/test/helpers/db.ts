import { PrismaClient } from '@prisma/client';

// Deletes in FK-safe (children-first) order. Run between every test so
// each test starts from a genuinely empty, known state — repeatable, no
// ordering dependencies between tests.
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.trendBreakoutSlotLock.deleteMany();
  await prisma.trendBreakoutDecision.deleteMany();
  await prisma.trendBreakoutEmergencyIncident.deleteMany();
  await prisma.trendBreakoutRiskState.deleteMany();
  await prisma.trendBreakoutVolumeAudit.deleteMany();
  await prisma.trendBreakoutVolumeSetting.deleteMany();
  await prisma.symbolMetadata.deleteMany();
  await prisma.historicalCandle.deleteMany();
  await prisma.marketEvent.deleteMany();
  await prisma.healthIncident.deleteMany();
  await prisma.healthStatus.deleteMany();
  await prisma.importBatch.deleteMany();
  await prisma.aiAnalysis.deleteMany();
  await prisma.alertDelivery.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.ruleState.deleteMany();
  await prisma.ruleDefinition.deleteMany();
  await prisma.trade.deleteMany();
  await prisma.position.deleteMany();
  await prisma.accountSnapshot.deleteMany();
  await prisma.collectorHeartbeat.deleteMany();
  await prisma.syncCursor.deleteMany();
  await prisma.apiCredential.deleteMany();
  await prisma.tradingAccount.deleteMany();
  await prisma.user.deleteMany();
}
