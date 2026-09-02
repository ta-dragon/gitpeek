import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import "./styles/theme.css";
import "./styles/app.css";
import "./styles/graph.css";

// 描画中の例外で木が外れると、ウィンドウが真っ白になって原因も残らない。
// index.html 側の受け皿はモジュールが読めなかった場合を、こちらは描画中を担当する。
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
