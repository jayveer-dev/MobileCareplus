import { useState } from "react";
import type { Device } from "../../shared/types";
import { FeatureList, TOOLBOX_FEATURES } from "./Features";
import { Icon } from "./Icons";

const cleanError = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export function Toolbox({ device }: { device?: Device }) {
  return (
    <div className="toolbox">
      <TransferCard />
      <h2 className="dash-title">More tools</h2>
      <FeatureList features={TOOLBOX_FEATURES} device={device} />
    </div>
  );
}

/** Mobile Care Plus Transfer is part of this app and opens in its own window. */
function TransferCard() {
  const [error, setError] = useState<string>();
  const open = () => {
    setError(undefined);
    window.modules.openTransfer().catch((e) => setError(cleanError(e)));
  };

  return (
    <article className="transfer-card">
      <span className="transfer-icon" aria-hidden="true">
        <Icon name="message" size={28} />
      </span>
      <div className="transfer-text">
        <h2>Mobile Care Plus Transfer</h2>
        <p className="muted">Move WhatsApp, WhatsApp Business, GBWhatsApp, Kik and Viber chats between phones, back them up, read and export them.</p>
        {error && <p className="error small">{error}</p>}
      </div>
      <div className="transfer-action">
        <button onClick={open}>Open</button>
      </div>
    </article>
  );
}
