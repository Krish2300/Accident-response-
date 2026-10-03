-- Append-only guarantees for the system event log.
--
-- The specification requires `system_events` to be an append-only log. Prisma
-- cannot express row triggers, so they are declared here. Together with the
-- autoincrement `seq` column this gives a total order that never depends on
-- wall-clock timestamps.
--
-- Operational consequence: emergencies are retired with
-- `status = 'CANCELLED'`, never with DELETE, because deleting an emergency
-- would cascade into the log and be (correctly) refused. `prisma migrate reset`
-- drops the tables wholesale and therefore still works.
--
-- Append-only violation attempts are auditable in application logs: the Prisma
-- error surfaces as P2010/raw "append-only" and is mapped to IMMUTABLE_RECORD.

CREATE TRIGGER IF NOT EXISTS system_events_prevent_update
BEFORE UPDATE ON system_events
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_RECORD: system_events is append-only; UPDATE is not permitted');
END;

CREATE TRIGGER IF NOT EXISTS system_events_prevent_delete
BEFORE DELETE ON system_events
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_RECORD: system_events is append-only; DELETE is not permitted');
END;

-- Positional integrity: a location row must belong to an ambulance and carry a
-- plausible coordinate. Prisma already enforces the FK, this guards the domain.
CREATE TRIGGER IF NOT EXISTS ambulance_locations_check_coordinates
BEFORE INSERT ON ambulance_locations
WHEN NEW.latitude < -90 OR NEW.latitude > 90 OR NEW.longitude < -180 OR NEW.longitude > 180
BEGIN
  SELECT RAISE(ABORT, 'VALIDATION_ERROR: ambulance_locations coordinates out of range');
END;

-- Protocol session steps must reference a session (FK is deferred to Prisma) and
-- carry a non-negative ordering index.
CREATE TRIGGER IF NOT EXISTS protocol_steps_check_order
BEFORE INSERT ON protocol_steps
WHEN NEW.orderIndex < 0
BEGIN
  SELECT RAISE(ABORT, 'VALIDATION_ERROR: protocol_steps.orderIndex must be >= 0');
END;
