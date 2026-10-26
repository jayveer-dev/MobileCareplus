import { useState } from "react";
import type { Device, Platform } from "../../shared/types";

/** A Toolbox tool: what it does, which phones it's for, and whether it works yet. */
export interface Feature {
  name: string;
  does: string;
  /** Phone types this tool is for; shown as tags on the card. */
  on: Platform[];
  /** Build phase from docs/PLAN.md for planned tools (shown as "Coming soon"); working tools have none. */
  phase?: number;
  /** Button label for working tools. */
  action?: string;
}

export const TOOLBOX_FEATURES: Feature[] = [
  { name: "Screenshot", does: "Capture the phone's screen into Pictures on this computer.", on: ["android", "ios"], action: "Take screenshot" },
  { name: "Recovery mode", does: "Put the phone into recovery mode or bring it back out.", on: ["ios", "android"], phase: 3 },
  { name: "Repair iOS", does: "Reinstall iOS with Apple's signed software when the phone won't start.", on: ["ios"], phase: 3 },
  { name: "Battery and diagnostics", does: "Battery health, charge cycles and hardware checks.", on: ["ios", "android"], phase: 3 },
  { name: "Convert HEIC photos", does: "Turn iPhone HEIC photos into JPG.", on: ["ios"], phase: 2 },
];

const OS_NAME: Record<Platform, string> = { ios: "iPhone", android: "Android" };
const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export function FeatureList({ features, device }: { features: Feature[]; device?: Device }) {
  const [note, setNote] = useState<{ name: string; text: string; error?: boolean }>();
  const [busy, setBusy] = useState<string>();

  const runTool = async (f: Feature) => {
    if (!device) return;
    setBusy(f.name);
    setNote(undefined);
    try {
      // The one working tool so far; a second one gets a dispatch table.
      await window.modules.screenshot(device.platform, device.id, device.name);
      setNote({ name: f.name, text: "Saved to Pictures › Mobile Care Plus." });
    } catch (e) {
      setNote({ name: f.name, text: clean(e), error: true });
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <ul className="features">
      {features.map((f) => {
        const forThisPhone = !!device && f.on.includes(device.platform);
        const ready = !f.phase;
        return (
          <li key={f.name} aria-disabled={ready ? undefined : "true"}>
            <h2>
              {f.name}
              {f.on.map((p) => (
                <span key={p} className={`pill os-tag ${p}`}>
                  {OS_NAME[p]}
                </span>
              ))}
            </h2>
            <p>{f.does}</p>
            {ready ? (
              <>
                <button className="secondary" disabled={!forThisPhone || busy === f.name} onClick={() => runTool(f)} title={forThisPhone ? undefined : `Connect ${f.on.map((p) => OS_NAME[p]).join(" or ")}`}>
                  {busy === f.name ? "Working…" : (f.action ?? "Run")}
                </button>
                {note?.name === f.name && <p className={`small ${note.error ? "error" : "muted"} tool-note`}>{note.text}</p>}
              </>
            ) : (
              <span className="soon">Coming soon</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
