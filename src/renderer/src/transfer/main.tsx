import { createRoot } from "react-dom/client";
import { App } from "./App";
// Shared design tokens and controls with the main app, then the transfer app's own layout.
import "../styles.css";
import "./transfer.css";

createRoot(document.getElementById("root")!).render(<App />);
