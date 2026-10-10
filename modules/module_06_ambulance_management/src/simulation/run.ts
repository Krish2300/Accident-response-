import { createPrismaClient } from '@resus/module_11_database_event_system';
import { createModule11 } from '@resus/module_11_database_event_system';
import { Module6 } from '../module.js';

async function main() {
  const db = createPrismaClient();
  const module11 = createModule11({ db });
  const module6 = new Module6({
    ambulances: module11.ambulances,
    events: module11.eventPublisher,
  });
  console.log('Module 6 simulation harness ready');
  await module11.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
