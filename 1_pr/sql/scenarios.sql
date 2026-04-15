-- Reference SQL for the three transactional scenarios (PostgreSQL).
-- Parameters are shown as $1, $2, ... Replace with concrete values or prepared statement bindings.

-- =============================================================================
-- Scenario 1: Place an order (single atomic transaction)
-- =============================================================================
BEGIN;

-- $1 = CustomerID (must exist)
-- After creating the order, $2 = new OrderID from RETURNING (application uses SERIAL)

INSERT INTO "Orders" ("CustomerID", "OrderDate", "TotalAmount")
VALUES ($1, NOW(), 0)
RETURNING "OrderID";

-- For each line: $order_id, $product_id, $quantity, $subtotal (price * quantity)
INSERT INTO "OrderItems" ("OrderID", "ProductID", "Quantity", "Subtotal")
VALUES ($2, $3, $4, $5);

-- Repeat INSERT for additional lines as needed, then set header total from lines:
UPDATE "Orders" AS o
SET "TotalAmount" = s.sum_subtotal
FROM (
  SELECT "OrderID", SUM("Subtotal") AS sum_subtotal
  FROM "OrderItems"
  WHERE "OrderID" = $2
  GROUP BY "OrderID"
) AS s
WHERE o."OrderID" = s."OrderID";

COMMIT;

-- On any failure before COMMIT, use ROLLBACK; (not shown) to abort the whole order.

-- =============================================================================
-- Scenario 2: Update customer email (atomic single-row update)
-- =============================================================================
BEGIN;

UPDATE "Customers"
SET "Email" = $2
WHERE "CustomerID" = $1;

-- Optional: check ROW_COUNT / FOUND in application layer; unique violation on Email rolls back.

COMMIT;

-- =============================================================================
-- Scenario 3: Insert new product (atomic insert)
-- =============================================================================
BEGIN;

INSERT INTO "Products" ("ProductName", "Price")
VALUES ($1, $2);

COMMIT;
