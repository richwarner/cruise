import { useEffect, useState } from "react";

type DispatchControlsProps = {
  systemId: string;
  onSystemIdChange: (next: string) => void;
  fleetSize: number;
  onResizeFleet: (size: number) => void;
  onReset: () => void;
  isResetting: boolean;
  isResizing: boolean;
};

export function DispatchControls({
  systemId,
  onSystemIdChange,
  fleetSize,
  onResizeFleet,
  onReset,
  isResetting,
  isResizing,
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
        className="dispatch-controls-reset"
        onClick={onReset}
        disabled={isResetting}
      >
        {isResetting ? "Resetting…" : "Reset dispatch"}
      </button>
    </div>
  );
}
