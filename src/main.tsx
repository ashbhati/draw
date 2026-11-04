import React from "react";
import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import "./ui/styles.css";
import App from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Draw could not find its root element.");

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
