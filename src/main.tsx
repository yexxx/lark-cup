import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";
import "./nature.css";
class Boundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="state">
        <h1>页面遇到一点问题</h1>
        <button onClick={() => location.reload()}>重新加载</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <Boundary>
    <App />
  </Boundary>,
);
