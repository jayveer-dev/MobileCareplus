import { useState } from "react";
import type { Device } from "../../../shared/types";
import { Icon } from "../Icons";
import { kind, PhonePair, usePhonePair } from "./PhonePair";

type Mode = "replace" | "merge";

/**
 * Transfer between phones: choose a source and a destination, replace or merge, then run checks.
 * The checks are real; the copy step itself (see docs/TRANSFER-DESIGN.md) isn't built yet, and the
 * screen says so instead of pretending.
 */
export function TransferScreen({ name, devices, onClose }: { name: string; devices: Device[]; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("replace");
  const [checking, setChecking] = useState(false);
  const pair = usePhonePair(devices);
  const { source, dest } = pair;

  return (
    <section className="xfer">
      <button className="quiet tx-back" onClick={onClose}>
        <span className="tx-back-icon">
          <Icon name="chevron" size={16} />
        </span>
        {name}
      </button>
      <div className="segmented xfer-mode" role="group" aria-label="Transfer mode">
        <button aria-pressed={mode === "replace"} onClick={() => setMode("replace")}>
          Transfer
        </button>
        <button aria-pressed={mode === "merge"} onClick={() => setMode("merge")}>
          Transfer and merge
        </button>
      </div>
      <p className="muted xfer-explain">
        {mode === "replace"
          ? `${name} chats on the destination phone are replaced by the source phone's chats.`
          : `${name} chats already on the destination phone are kept, and the source phone's chats are added to them.`}
      </p>

      <PhonePair devices={devices} pair={pair} />

      <div className="xfer-foot">
        <button className="xfer-go" disabled={!source || !dest} onClick={() => setChecking(true)}>
          Transfer
        </button>
      </div>

      {checking && source && dest && <Checks name={name} mode={mode} source={source} dest={dest} onClose={() => setChecking(false)} />}
    </section>
  );
}

type Check = { ok: boolean | "you"; text: string };

/** What has to be true before copying; "you" marks steps only the person can confirm on the phone. */
function checksFor(name: string, mode: Mode, source: Device, dest: Device): Check[] {
  const list: Check[] = [
    { ok: source.state === "ready", text: `${source.name} is connected and trusts this computer` },
    { ok: dest.state === "ready", text: `${dest.name} is connected and trusts this computer` },
    { ok: source.id !== dest.id, text: "Source and destination are different phones" },
    { ok: "you", text: `${name} on both phones uses the same phone number` },
  ];
  if (source.platform === "android") list.push({ ok: "you", text: `On ${source.name}: ${name} › Settings › Chats › Chat backup › End-to-end encrypted backup is on with a 64-digit key, and a backup was made` });
  if (dest.platform === "android") list.push({ ok: "you", text: `On ${dest.name}: end-to-end encrypted backup with a 64-digit key is on (it's used to write the chats back)` });
  if (dest.platform === "ios") list.push({ ok: "you", text: `On ${dest.name}: Find My is turned off and ${name} is installed and signed in` });
  if (mode === "replace") list.push({ ok: "you", text: `${name} chats on ${dest.name} will be replaced; Mobile Care Plus backs them up first` });
  return list;
}

function Checks({ name, mode, source, dest, onClose }: { name: string; mode: Mode; source: Device; dest: Device; onClose: () => void }) {
  const list = checksFor(name, mode, source, dest);
  const blocked = list.some((c) => c.ok === false);
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="xfer-check-title">
      <div className="dialog xfer-checks">
        <h3 id="xfer-check-title">
          {kind(source)} → {kind(dest)}
        </h3>
        <p className="muted">
          {source.name} to {dest.name}, {mode === "replace" ? "replacing" : "merging with"} the destination's chats.
        </p>
        <ul>
          {list.map((c) => (
            <li key={c.text} className={c.ok === false ? "bad" : c.ok === true ? "good" : "you"}>
              <span className="xfer-mark" aria-hidden="true">
                {c.ok === true ? "✓" : c.ok === false ? "✕" : "•"}
              </span>
              {c.text}
            </li>
          ))}
        </ul>
        <p className="callout">
          {blocked
            ? "Fix the items marked ✕, then try again."
            : "The copy step between these phones is being built now. Nothing on either phone has been changed."}
        </p>
        <div className="row end">
          <button onClick={onClose}>OK</button>
        </div>
      </div>
    </div>
  );
}
