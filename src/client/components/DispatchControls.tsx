import { useEffect, useState } from "react";

import type { CityId } from "../../shared/types";

type DispatchControlsProps = {
  systemId: string;
  onSystemIdChange: (next: string) => void;
  fleetSize: number;
  onResizeFleet: (size: number) => void;
  onReset: () => void;
  onSubmitTestOrder: () => void;
  isResetting: boolean;
  isResizing: boolean;
  isSubmittingOrder: boolean;
};

const TEST_ORDER_PICKUP: CityId = "OPO";
const TEST_ORDER_DROPOFF: CityId = "FAO";
const TEST_ORDER_PALLETS = 2;

/**
 * Header controls. Phase 4 adds a "Submit test order" button so the new-order
 * round can be exercised without requiring a dispatcher chat turn. The button
 * always submits the same canned order (OPO → FAO × 4) so the result is
 * reproducible across runs.
 */
export function DispatchControls({
  systemId,
  onSystemIdChange,
  fleetSize,
  onResizeFleet,
  onReset,
  onSubmitTestOrder,
  isResetting,
  isResizing,
  isSubmittingOrder,
}: DispatchControlsProps) {
  const [draftSystemId, setDraftSystemId] = useState(systemId);

  useEffect(() => {
    setDraftSystemId(systemId);
  }, [systemId]);

  return (
    <div className="dispatch-controls">
      <label className="dispatch-controls-field">
        <span>System ID</span>
        <input
          type="text"
          value={draftSystemId}
          onChange={(e) => setDraftSystemId(e.target.value)}
          onBlur={() => {
            const next = draftSystemId.trim();
            if (next && next !== systemId) onSystemIdChange(next);
            else setDraftSystemId(systemId);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          spellCheck={false}
        />
      </label>

      <label className="dispatch-controls-field">
        <span>Fleet size</span>
        <input
          type="number"
          min={1}
          max={50}
          value={fleetSize}
          disabled={isResizing}
          onChange={(e) => {
            const next = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(next) && next !== fleetSize) {
              onResizeFleet(next);
            }
          }}
        />
      </label>

      <button
        type="button"
        className="dispatch-controls-test"
        onClick={onSubmitTestOrder}
        disabled={isSubmittingOrder}
        title={`Submit ${TEST_ORDER_PALLETS} pallets ${TEST_ORDER_PICKUP} → ${TEST_ORDER_DROPOFF}`}
      >
        {isSubmittingOrder ? "Planning…" : "Submit test order"}
      </button>

      <button
        type="button"
        className="dispatch-controls-reset"
        onClick={onReset}
        disabled={isResetting}
      >
        {isResetting ? "Resetting…" : "Reset dispatch"}
      </button>
    </div>
  );
}

export const TEST_ORDER = {
  orderId: "O-13",
  pickup: TEST_ORDER_PICKUP,
  dropoff: TEST_ORDER_DROPOFF,
  pallets: TEST_ORDER_PALLETS,
  summary: `${TEST_ORDER_PALLETS} pallets ${TEST_ORDER_PICKUP} -> ${TEST_ORDER_DROPOFF} (test)`,
} as const;
