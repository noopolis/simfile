import { createRoot } from "react-dom/client";

import { SimfileViewerApp } from "./viewer/App.js";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root element");
}

createRoot(root).render(<SimfileViewerApp />);
