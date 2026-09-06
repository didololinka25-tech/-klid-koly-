const INSERT_LEGACY_ORDER_SQL = `insert into public.cafeteria_orders
  (diner_id, meal_day_id, meal_variant_id, quantity, status)
 values ($1, $2, $3, $4, 'ordered')
 returning id`

const SNAPSHOT_LEGACY_EVENT_SQL = `with imported_event as materialized (
  select e.id, e.actor_source, d.cutoff_at, d.cutoff_at <= now() as cutoff_passed
  from public.cafeteria_order_events e
  join public.cafeteria_meal_days d on d.id = e.meal_day_id
  where e.order_id = $1 and e.event_type = 'ordered'
  order by e.occurred_at desc, e.id desc
  limit 1
), adjusted as (
  update public.cafeteria_order_events e
  set occurred_at = imported_event.cutoff_at - interval '1 second'
  from imported_event
  where e.id = imported_event.id
    and imported_event.actor_source = 'system'
    and imported_event.cutoff_passed
  returning e.id
)
select imported_event.id as event_id,
       imported_event.actor_source,
       imported_event.cutoff_passed,
       exists (select 1 from adjusted) as snapshot_adjusted
from imported_event`

export async function insertLegacyOrder(client, item) {
  const inserted = await client.query(INSERT_LEGACY_ORDER_SQL, [
    item.diner.id,
    item.mealDay.id,
    item.variant.id,
    item.quantity,
  ])
  const orderId = inserted.rows[0]?.id
  if (!orderId) throw new Error('Importovaná objednávka nevrátila své ID.')

  const snapshot = await client.query(SNAPSHOT_LEGACY_EVENT_SQL, [orderId])
  const event = snapshot.rows[0]
  if (!event) throw new Error('Pro importovanou objednávku nevznikl auditní event.')
  if (event.actor_source !== 'system') throw new Error('Auditní event importované objednávky nemá actor_source system.')
  if (Boolean(event.cutoff_passed) !== Boolean(event.snapshot_adjusted)) {
    throw new Error('Auditní event importované objednávky nebyl správně zařazen do cutoff snapshotu.')
  }

  return {
    orderId,
    cutoffPassed: Boolean(event.cutoff_passed),
    snapshotAdjusted: Boolean(event.snapshot_adjusted),
  }
}

export const legacyApplySql = Object.freeze({
  insertOrder: INSERT_LEGACY_ORDER_SQL,
  snapshotEvent: SNAPSHOT_LEGACY_EVENT_SQL,
})
