import { useEffect, useState } from "react";
import type { Device } from "../../../shared/types";
import { Icon } from "../Icons";

const key = (d: Device) => `${d.platform}:${d.id}`;
export const kind = (d?: Device) => (d ? (d.platform === "ios" ? "iPhone" : "Android") : "");

/** Which connected phone is the source and which the destination; keeps choices while still connected. */
export function usePhonePair(devices: Device[]) {
  const [sourceKey, setSourceKey] = useState<string>();
  const [destKey, setDestKey] = useState<string>();
  useEffect(() => {
    const keys = devices.map(key);
    setSourceKey((s) => (s && keys.includes(s) ? s : keys[0]));
    setDestKey((d) => (d && keys.includes(d) ? d : keys.find((k) => k !== (sourceKey ?? keys[0]))));
  }, [devices, sourceKey]);
  return {
    source: devices.find((d) => key(d) === sourceKey),
    dest: devices.find((d) => key(d) === destKey),
    sourceKey,
    destKey,
    setSourceKey,
    setDestKey,
    swap: () => {
      setSourceKey(destKey);
      setDestKey(sourceKey);
    },
  };
}

/** Source and destination cards with a swap button between them, and the "not showing?" help. */
export function PhonePair({ devices, pair, labels = ["Source", "Destination"] }: { devices: Device[]; pair: ReturnType<typeof usePhonePair>; labels?: [string, string] }) {
  const [help, setHelp] = useState(false);
  return (
    <>
      <div className="xfer-phones">
        <PhoneCard role={labels[0]} devices={devices} value={pair.sourceKey} other={pair.destKey} onChange={pair.setSourceKey} device={pair.source} />
        <button className="xfer-swap" onClick={pair.swap} disabled={!pair.source && !pair.dest} aria-label={`Swap ${labels[0].toLowerCase()} and ${labels[1].toLowerCase()}`} title="Swap">
          <Icon name="swap" size={22} />
        </button>
        <PhoneCard role={labels[1]} devices={devices} value={pair.destKey} other={pair.sourceKey} onChange={pair.setDestKey} device={pair.dest} />
      </div>
      <p className="xfer-help">
        <button className="link" onClick={() => setHelp(true)}>
          Phone connected but not showing?
        </button>
      </p>
      {help && <Help onClose={() => setHelp(false)} />}
    </>
  );
}

function PhoneCard({ role, devices, value, other, onChange, device }: { role: string; devices: Device[]; value?: string; other?: string; onChange: (k: string) => void; device?: Device }) {
  return (
    <div className="xfer-card">
      <label className="xfer-pick">
        <span className="muted">{role}</span>
        <select value={value ?? ""} onChange={(e) => onChange(e.target.value)} aria-label={`${role} phone`} disabled={devices.length === 0}>
          {!value && <option value="">{devices.length === 0 ? "No phone connected" : "Choose a phone"}</option>}
          {devices.map((d) => (
            <option key={key(d)} value={key(d)} disabled={key(d) === other}>
              {d.name} ({kind(d)})
            </option>
          ))}
        </select>
      </label>
      <div className={`xfer-phone ${device ? device.platform : "empty"}`} aria-hidden="true">
        <span className="xfer-screen">
          <span className="xfer-kind">{device ? kind(device) : "Connect a phone"}</span>
          {device && device.state !== "ready" && <span className="xfer-state">{device.state === "untrusted" ? "Not trusted yet" : "Not responding"}</span>}
        </span>
      </div>
    </div>
  );
}

function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="xfer-help-title">
      <div className="dialog xfer-checks">
        <h3 id="xfer-help-title">Phone not showing?</h3>
        <h4>iPhone</h4>
        <ul className="plain">
          <li>Use a cable that carries data, not a charge-only one.</li>
          <li>Unlock the iPhone and tap Trust when it asks.</li>
          <li>On Windows, install Apple's "Apple Devices" app for the iPhone driver.</li>
        </ul>
        <h4>Android</h4>
        <ul className="plain">
          <li>Settings › About phone: tap Build number 7 times to turn on Developer options.</li>
          <li>Developer options: turn on USB debugging.</li>
          <li>Choose File transfer for the USB connection, then tap Allow on the debugging prompt.</li>
        </ul>
        <div className="row end">
          <button onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
