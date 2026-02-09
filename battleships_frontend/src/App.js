import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/**
 * Battleships UI notes:
 * - This frontend is designed to work with an existing backend, but backend routes can vary.
 * - We therefore:
 *   1) Centralize base URLs from .env
 *   2) Provide a tolerant REST client with a couple of common endpoint patterns
 *   3) Prefer WS events for live updates when available
 *
 * Required env vars (already present in container .env):
 * - REACT_APP_API_BASE (preferred for REST)
 * - REACT_APP_BACKEND_URL (fallback for REST)
 * - REACT_APP_WS_URL (WebSocket base, e.g. ws(s)://host/ws)
 */

/** Board size for classic Battleships. */
const GRID_SIZE = 10;

/** Ship definitions for classic rules. */
const DEFAULT_SHIPS = [
  { id: "carrier", name: "Carrier", size: 5 },
  { id: "battleship", name: "Battleship", size: 4 },
  { id: "cruiser", name: "Cruiser", size: 3 },
  { id: "submarine", name: "Submarine", size: 3 },
  { id: "destroyer", name: "Destroyer", size: 2 },
];

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function keyOf(r, c) {
  return `${r},${c}`;
}

function parseKey(k) {
  const [r, c] = k.split(",").map((x) => Number(x));
  return { r, c };
}

function makeEmptyGrid(value = "unknown") {
  return Array.from({ length: GRID_SIZE }, () => Array.from({ length: GRID_SIZE }, () => value));
}

function inBounds(r, c) {
  return r >= 0 && r < GRID_SIZE && c >= 0 && c < GRID_SIZE;
}

function buildShipCells(anchor, size, orientation) {
  const cells = [];
  for (let i = 0; i < size; i += 1) {
    const r = orientation === "horizontal" ? anchor.r : anchor.r + i;
    const c = orientation === "horizontal" ? anchor.c + i : anchor.c;
    cells.push({ r, c });
  }
  return cells;
}

function overlapsAny(cells, occupiedSet) {
  return cells.some((p) => occupiedSet.has(keyOf(p.r, p.c)));
}

function allInBounds(cells) {
  return cells.every((p) => inBounds(p.r, p.c));
}

/**
 * A very small, tolerant REST client that tries a couple of common endpoint patterns.
 */
function useApiClient() {
  const apiBase =
    process.env.REACT_APP_API_BASE ||
    process.env.REACT_APP_BACKEND_URL ||
    "";

  const normalizedBase = useMemo(() => {
    const b = (apiBase || "").trim();
    return b.endsWith("/") ? b.slice(0, -1) : b;
  }, [apiBase]);

  async function requestJson(path, options = {}) {
    if (!normalizedBase) {
      throw new Error(
        "Missing API base URL. Ensure REACT_APP_API_BASE or REACT_APP_BACKEND_URL is set in .env."
      );
    }

    const url = `${normalizedBase}${path.startsWith("/") ? "" : "/"}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });

    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    if (!res.ok) {
      const msg =
        typeof parsed === "string"
          ? parsed
          : parsed?.detail || parsed?.message || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return parsed;
  }

  /**
   * Try multiple potential endpoints until one works.
   * This keeps the UI usable across slightly different backend route designs.
   */
  async function tryPostJson(paths, body) {
    let lastErr = null;
    for (const p of paths) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await requestJson(p, { method: "POST", body: JSON.stringify(body) });
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("Request failed");
  }

  async function tryGetJson(paths) {
    let lastErr = null;
    for (const p of paths) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await requestJson(p, { method: "GET" });
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("Request failed");
  }

  return { apiBase: normalizedBase, requestJson, tryPostJson, tryGetJson };
}

function useWebSocketConnection({ onMessage }) {
  const wsUrlRaw = process.env.REACT_APP_WS_URL || "";
  const wsUrl = useMemo(() => wsUrlRaw.trim(), [wsUrlRaw]);
  const wsRef = useRef(null);
  const [wsStatus, setWsStatus] = useState("disconnected"); // disconnected | connecting | connected | error

  useEffect(() => {
    if (!wsUrl) return undefined;

    setWsStatus("connecting");
    let alive = true;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!alive) return;
        setWsStatus("connected");
      };

      ws.onclose = () => {
        if (!alive) return;
        setWsStatus("disconnected");
      };

      ws.onerror = () => {
        if (!alive) return;
        setWsStatus("error");
      };

      ws.onmessage = (evt) => {
        if (!alive) return;
        let parsed = null;
        try {
          parsed = JSON.parse(evt.data);
        } catch {
          parsed = { type: "raw", data: evt.data };
        }
        onMessage?.(parsed);
      };
    } catch {
      setWsStatus("error");
    }

    return () => {
      alive = false;
      try {
        wsRef.current?.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    };
  }, [wsUrl, onMessage]);

  const sendJson = (obj) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  };

  return { wsStatus, sendJson, wsUrl };
}

/**
 * UI Cell states
 * ownGrid: "water" | "ship" | "hit" | "miss"
 * oppGrid: "unknown" | "hit" | "miss" | "sunk"
 */

function deriveOwnGridFromPlacementAndShots(placementSet, incomingShotsMap) {
  // incomingShotsMap: key -> "hit" | "miss"
  const g = makeEmptyGrid("water");
  placementSet.forEach((k) => {
    const { r, c } = parseKey(k);
    if (inBounds(r, c)) g[r][c] = "ship";
  });

  Object.entries(incomingShotsMap).forEach(([k, v]) => {
    const { r, c } = parseKey(k);
    if (!inBounds(r, c)) return;
    if (v === "hit") g[r][c] = "hit";
    if (v === "miss") g[r][c] = "miss";
  });

  return g;
}

function Button({ variant = "primary", size = "md", ...props }) {
  const cls = ["btn", `btn-${variant}`, size === "lg" ? "btn-lg" : ""].filter(Boolean).join(" ");
  return <button className={cls} {...props} />;
}

function Badge({ tone = "neutral", children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function BoardGrid({
  title,
  subtitle,
  grid,
  mode,
  selectable,
  selectedKey,
  onCellHover,
  onCellClick,
  ariaLabel,
}) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div className="panel-titleblock">
          <h2 className="panel-title">{title}</h2>
          {subtitle ? <p className="panel-subtitle">{subtitle}</p> : null}
        </div>
      </div>

      <div className="grid-wrap" role="group" aria-label={ariaLabel}>
        <div className="grid-axis grid-axis-top" aria-hidden="true">
          {Array.from({ length: GRID_SIZE }, (_, i) => (
            <div key={i} className="grid-axis-cell">
              {String.fromCharCode("A".charCodeAt(0) + i)}
            </div>
          ))}
        </div>

        <div className="grid-axis grid-axis-left" aria-hidden="true">
          {Array.from({ length: GRID_SIZE }, (_, i) => (
            <div key={i} className="grid-axis-cell">
              {i + 1}
            </div>
          ))}
        </div>

        <div className="grid" role="grid">
          {grid.map((row, r) =>
            row.map((cell, c) => {
              const k = keyOf(r, c);
              const isSelected = selectedKey === k;
              const base = ["cell", `cell-${cell}`, `cell-mode-${mode}`, selectable ? "cell-clickable" : ""]
                .filter(Boolean)
                .join(" ");

              return (
                <button
                  key={k}
                  type="button"
                  className={`${base} ${isSelected ? "cell-selected" : ""}`}
                  onMouseEnter={() => onCellHover?.(r, c)}
                  onFocus={() => onCellHover?.(r, c)}
                  onClick={() => onCellClick?.(r, c)}
                  disabled={!selectable}
                  role="gridcell"
                  aria-label={`${String.fromCharCode("A".charCodeAt(0) + c)}${r + 1} ${cell}`}
                >
                  <span className="cell-dot" aria-hidden="true" />
                </button>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}

// PUBLIC_INTERFACE
function App() {
  const { tryPostJson } = useApiClient();

  // Theme
  const [theme, setTheme] = useState("light");
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Match style guide (light modern): keep app light by default.
  useEffect(() => {
    setTheme("light");
  }, []);

  // Placement state
  const [ships, setShips] = useState(() =>
    DEFAULT_SHIPS.map((s) => ({ ...s, placed: false, cells: [], orientation: "horizontal" }))
  );
  const [selectedShipId, setSelectedShipId] = useState(DEFAULT_SHIPS[0].id);
  const [orientation, setOrientation] = useState("horizontal");

  // occupied cells from placed ships
  const placementSet = useMemo(() => {
    const set = new Set();
    ships.forEach((s) => {
      s.cells.forEach((p) => set.add(keyOf(p.r, p.c)));
    });
    return set;
  }, [ships]);

  // own shots received from opponent (for visuals)
  const [incomingShots, setIncomingShots] = useState(() => ({})); // key -> "hit" | "miss"

  // opponent grid state
  const [opponentGrid, setOpponentGrid] = useState(() => makeEmptyGrid("unknown"));

  // hover preview for placement
  const [hoverKey, setHoverKey] = useState(null);
  const previewCells = useMemo(() => {
    if (!hoverKey) return [];
    const ship = ships.find((s) => s.id === selectedShipId);
    if (!ship) return [];
    const anchor = parseKey(hoverKey);
    const cells = buildShipCells(anchor, ship.size, orientation);
    return cells;
  }, [hoverKey, ships, selectedShipId, orientation]);

  const previewValidity = useMemo(() => {
    if (!previewCells.length) return { ok: true, reason: "" };
    if (!allInBounds(previewCells)) return { ok: false, reason: "Out of bounds" };
    if (overlapsAny(previewCells, placementSet)) return { ok: false, reason: "Overlaps another ship" };
    return { ok: true, reason: "" };
  }, [previewCells, placementSet]);

  const ownGrid = useMemo(() => deriveOwnGridFromPlacementAndShots(placementSet, incomingShots), [placementSet, incomingShots]);

  // Game / session info (best-effort without hard backend requirements)
  const [gamePhase, setGamePhase] = useState("placing"); // placing | waiting | playing | finished
  const [turn, setTurn] = useState("you"); // you | opponent
  const [statusText, setStatusText] = useState("Place your fleet to begin.");
  const [lastMove, setLastMove] = useState(null); // { by, at, result }

  // selection for firing
  const [selectedTargetKey, setSelectedTargetKey] = useState(null);

  const allPlaced = useMemo(() => ships.every((s) => s.placed), [ships]);

  const { wsStatus, sendJson } = useWebSocketConnection({
    onMessage: (msg) => {
      /**
       * Expected (example) message shapes we tolerate:
       * - { type: "turn", value: "you" | "opponent" }
       * - { type: "phase", value: "placing" | "waiting" | "playing" | "finished" }
       * - { type: "status", text: "..." }
       * - { type: "shot_result", by: "you"|"opponent", row, col, result: "hit"|"miss"|"sunk" }
       * - { type: "opponent_grid", grid: [["unknown"|"hit"|"miss"|"sunk", ...], ...] }
       * - { type: "incoming_shot", row, col, result: "hit"|"miss" }
       */
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "turn" && (msg.value === "you" || msg.value === "opponent")) {
        setTurn(msg.value);
        setStatusText(msg.value === "you" ? "Your turn — fire at will." : "Opponent's turn…");
      }

      if (msg.type === "phase" && typeof msg.value === "string") {
        setGamePhase(msg.value);
      }

      if (msg.type === "status" && typeof msg.text === "string") {
        setStatusText(msg.text);
      }

      if (msg.type === "opponent_grid" && Array.isArray(msg.grid)) {
        setOpponentGrid(msg.grid);
      }

      if (msg.type === "incoming_shot" && Number.isFinite(msg.row) && Number.isFinite(msg.col)) {
        const k = keyOf(msg.row, msg.col);
        const res = msg.result === "hit" ? "hit" : "miss";
        setIncomingShots((prev) => ({ ...prev, [k]: res }));
        setLastMove({ by: "opponent", at: k, result: res });
      }

      if (msg.type === "shot_result" && Number.isFinite(msg.row) && Number.isFinite(msg.col)) {
        const k = keyOf(msg.row, msg.col);
        const res = msg.result === "hit" ? "hit" : msg.result === "sunk" ? "sunk" : "miss";
        setOpponentGrid((prev) => {
          const next = prev.map((row) => row.slice());
          if (inBounds(msg.row, msg.col)) next[msg.row][msg.col] = res;
          return next;
        });
        setLastMove({ by: msg.by || "you", at: k, result: res });
      }
    },
  });

  const placeSelectedShipAt = (r, c) => {
    const ship = ships.find((s) => s.id === selectedShipId);
    if (!ship) return;

    const anchor = { r, c };
    const cells = buildShipCells(anchor, ship.size, orientation);
    if (!allInBounds(cells)) return;
    if (overlapsAny(cells, placementSet)) return;

    setShips((prev) =>
      prev.map((s) =>
        s.id !== ship.id
          ? s
          : {
              ...s,
              placed: true,
              orientation,
              cells,
            }
      )
    );
  };

  const resetPlacement = () => {
    setShips(DEFAULT_SHIPS.map((s) => ({ ...s, placed: false, cells: [], orientation: "horizontal" })));
    setSelectedShipId(DEFAULT_SHIPS[0].id);
    setOrientation("horizontal");
    setIncomingShots({});
    setOpponentGrid(makeEmptyGrid("unknown"));
    setGamePhase("placing");
    setTurn("you");
    setStatusText("Place your fleet to begin.");
    setLastMove(null);
    setSelectedTargetKey(null);
  };

  const startGame = async () => {
    if (!allPlaced) {
      setStatusText("Place all ships before starting.");
      return;
    }

    const fleet = ships.map((s) => ({
      id: s.id,
      name: s.name,
      size: s.size,
      orientation: s.orientation,
      cells: s.cells, // [{r,c}]
    }));

    // Prefer WS registration if available; fall back to REST.
    const wsOk = sendJson({ type: "place_ships", fleet });
    if (wsOk) {
      setGamePhase("waiting");
      setStatusText("Fleet submitted. Waiting for opponent…");
      return;
    }

    try {
      // Try common variants:
      // - POST /game/place-ships
      // - POST /games/place-ships
      // - POST /place-ships
      await tryPostJson(["/game/place-ships", "/games/place-ships", "/place-ships"], { fleet });
      setGamePhase("waiting");
      setStatusText("Fleet submitted. Waiting for opponent…");
    } catch (e) {
      setStatusText(`Could not submit fleet: ${e.message}`);
    }
  };

  const fireAt = async (r, c) => {
    if (gamePhase !== "playing") return;
    if (turn !== "you") return;

    const cellState = opponentGrid[r][c];
    if (cellState !== "unknown") {
      setStatusText("You already fired at that coordinate.");
      return;
    }

    const payload = { row: r, col: c };
    setSelectedTargetKey(keyOf(r, c));

    // Prefer WS for real-time; fall back to REST.
    const wsOk = sendJson({ type: "fire", ...payload });
    if (wsOk) {
      setStatusText("Shot fired…");
      setTurn("opponent");
      return;
    }

    try {
      // Try common variants:
      // - POST /game/fire
      // - POST /games/fire
      // - POST /fire
      const res = await tryPostJson(["/game/fire", "/games/fire", "/fire"], payload);
      const result = res?.result || res?.outcome || res?.status;
      const normalized = result === "hit" ? "hit" : result === "sunk" ? "sunk" : "miss";

      setOpponentGrid((prev) => {
        const next = prev.map((row) => row.slice());
        next[r][c] = normalized;
        return next;
      });

      setLastMove({ by: "you", at: keyOf(r, c), result: normalized });
      setStatusText(normalized === "hit" || normalized === "sunk" ? "Direct hit!" : "Miss.");
      setTurn("opponent");
    } catch (e) {
      setStatusText(`Could not fire: ${e.message}`);
      setSelectedTargetKey(null);
    }
  };

  const placedShipIds = useMemo(() => new Set(ships.filter((s) => s.placed).map((s) => s.id)), [ships]);

  const placementHelp = useMemo(() => {
    if (gamePhase !== "placing") return null;
    if (!hoverKey) return "Hover on your grid, then click to place the selected ship.";
    if (!previewCells.length) return "Select a ship to place.";
    if (!previewValidity.ok) return `Cannot place: ${previewValidity.reason}`;
    return "Click to place ship.";
  }, [gamePhase, hoverKey, previewCells.length, previewValidity]);

  const turnBadgeTone = turn === "you" ? "success" : "neutral";

  return (
    <div className="App battleships">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">
              B
            </div>
            <div className="brand-text">
              <h1 className="app-title">Battleships</h1>
              <p className="app-subtitle">Place ships, take turns, and sink the fleet.</p>
            </div>
          </div>

          <div className="topbar-status">
            <div className="status-row">
              <Badge tone={turnBadgeTone}>
                Turn: {gamePhase === "playing" ? (turn === "you" ? "You" : "Opponent") : "—"}
              </Badge>
              <Badge tone={wsStatus === "connected" ? "success" : wsStatus === "error" ? "error" : "neutral"}>
                WS: {wsStatus}
              </Badge>
              <Badge tone="neutral">Phase: {gamePhase}</Badge>
            </div>
            <p className="status-text" aria-live="polite">
              {statusText}
            </p>
            {lastMove ? (
              <p className="status-subtext">
                Last move: <strong>{lastMove.by}</strong> at{" "}
                <strong>
                  {String.fromCharCode("A".charCodeAt(0) + parseKey(lastMove.at).c)}
                  {parseKey(lastMove.at).r + 1}
                </strong>{" "}
                → <strong>{lastMove.result}</strong>
              </p>
            ) : null}
          </div>

          <button
            className="theme-toggle"
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            type="button"
          >
            {theme === "light" ? "Dark" : "Light"}
          </button>
        </div>
      </header>

      <main className="main">
        <section className="sidebar panel">
          <div className="panel-header">
            <div className="panel-titleblock">
              <h2 className="panel-title">Ship placement</h2>
              <p className="panel-subtitle">Select a ship, rotate, then place on your grid.</p>
            </div>
          </div>

          <div className="placement-controls">
            <div className="control-block">
              <label className="label" htmlFor="shipSelect">
                Ship
              </label>
              <select
                id="shipSelect"
                className="select"
                value={selectedShipId}
                onChange={(e) => setSelectedShipId(e.target.value)}
                disabled={gamePhase !== "placing"}
              >
                {ships.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.size}) {s.placed ? "— placed" : ""}
                  </option>
                ))}
              </select>
            </div>

            <div className="control-block">
              <span className="label">Orientation</span>
              <div className="segmented" role="radiogroup" aria-label="Orientation">
                <button
                  type="button"
                  className={`segmented-btn ${orientation === "horizontal" ? "is-active" : ""}`}
                  onClick={() => setOrientation("horizontal")}
                  disabled={gamePhase !== "placing"}
                  role="radio"
                  aria-checked={orientation === "horizontal"}
                >
                  Horizontal
                </button>
                <button
                  type="button"
                  className={`segmented-btn ${orientation === "vertical" ? "is-active" : ""}`}
                  onClick={() => setOrientation("vertical")}
                  disabled={gamePhase !== "placing"}
                  role="radio"
                  aria-checked={orientation === "vertical"}
                >
                  Vertical
                </button>
              </div>
            </div>

            <div className="fleet-list" aria-label="Fleet status">
              {ships.map((s) => (
                <div key={s.id} className={`fleet-item ${s.id === selectedShipId ? "is-selected" : ""}`}>
                  <div className="fleet-name">
                    {s.name} <span className="fleet-size">({s.size})</span>
                  </div>
                  <div className="fleet-state">
                    {placedShipIds.has(s.id) ? <Badge tone="success">Placed</Badge> : <Badge tone="neutral">Pending</Badge>}
                  </div>
                </div>
              ))}
            </div>

            <div className="hint" aria-live="polite">
              {placementHelp}
            </div>

            <div className="actions">
              <Button
                variant="primary"
                size="lg"
                onClick={startGame}
                disabled={gamePhase !== "placing" || !allPlaced}
              >
                Start game
              </Button>
              <Button variant="secondary" onClick={resetPlacement}>
                Reset
              </Button>
            </div>
          </div>
        </section>

        <section className="boards">
          <BoardGrid
            title="Your waters"
            subtitle={gamePhase === "placing" ? "Click to place ships (no overlap)." : "Incoming shots show hit/miss."}
            grid={applyPlacementPreview(ownGrid, previewCells, previewValidity.ok, gamePhase === "placing")}
            mode="own"
            selectable={gamePhase === "placing"}
            selectedKey={hoverKey}
            onCellHover={(r, c) => setHoverKey(keyOf(r, c))}
            onCellClick={(r, c) => {
              if (gamePhase !== "placing") return;
              const ship = ships.find((s) => s.id === selectedShipId);
              if (!ship) return;
              if (ship.placed) return;
              placeSelectedShipAt(r, c);
            }}
            ariaLabel="Your board"
          />

          <BoardGrid
            title="Opponent waters"
            subtitle={gamePhase === "playing" ? "Click a coordinate to fire." : "Waiting for game to start."}
            grid={opponentGrid}
            mode="opponent"
            selectable={gamePhase === "playing" && turn === "you"}
            selectedKey={selectedTargetKey}
            onCellHover={null}
            onCellClick={(r, c) => fireAt(r, c)}
            ariaLabel="Opponent board"
          />
        </section>
      </main>

      <footer className="footer">
        <div className="footer-inner">
          <div className="footer-note">
            Tip: The UI updates in real time via WebSocket when available. If WS is disconnected, REST fallbacks are used.
          </div>
        </div>
      </footer>
    </div>
  );
}

/**
 * Apply a placement preview overlay (soft highlight) on top of the own grid.
 * This is purely a UI effect; actual placement is stored in ships[].
 */
function applyPlacementPreview(ownGrid, previewCells, ok, enabled) {
  if (!enabled || !previewCells.length) return ownGrid;

  const g = ownGrid.map((row) => row.slice());
  previewCells.forEach(({ r, c }) => {
    if (!inBounds(r, c)) return;
    // Do not override definitive states.
    if (g[r][c] === "hit" || g[r][c] === "miss") return;
    if (g[r][c] === "ship") return;

    g[r][c] = ok ? "preview-ok" : "preview-bad";
  });
  return g;
}

export default App;
