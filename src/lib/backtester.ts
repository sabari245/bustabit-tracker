export type BacktestGame = {
  gameId: number;
  hash: string;
  bust: number;
};

export type BacktestPoint = {
  gameId: number;
  balance: number;
  profit: number;
};

export type BacktestResult = {
  name: string;
  script: string;
  startingBalance: number;
  startGameId: number;
  endGameId: number;
  games: number;
  finalBalance: number;
  profit: number;
  wagered: number;
  bets: number;
  wins: number;
  losses: number;
  maxDrawdown: number;
  createdAt: string;
  resultJson: string;
};

type Bet = {
  wager: number;
  payoutCenti: number;
};

export type StopMarker = {
  gameId: number;
  reason: string;
};

type HistoryGame = BacktestGame & {
  id: number;
  wager: number | null;
  cashedAt: number | null;
};

type Listener = (...args: unknown[]) => void;

const MAX_BALANCE_SERIES_POINTS = 2400;

class Emitter {
  private listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener) {
    const current = this.listeners.get(event) ?? [];
    current.push(listener);
    this.listeners.set(event, current);
    return this;
  }

  once(event: string, listener: Listener) {
    const wrapped: Listener = (...args) => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  removeListener(event: string, listener: Listener) {
    const current = this.listeners.get(event);
    if (!current) return this;
    this.listeners.set(
      event,
      current.filter((item) => item !== listener),
    );
    return this;
  }

  off(event: string, listener: Listener) {
    return this.removeListener(event, listener);
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(...args);
    }
  }
}

class HistoryBuffer {
  private games: HistoryGame[] = [];

  first() {
    return this.games[0] ?? null;
  }

  last() {
    return this.games[this.games.length - 1] ?? null;
  }

  toArray() {
    return [...this.games];
  }

  push(game: HistoryGame) {
    this.games.unshift(game);
    if (this.games.length > 50) this.games.pop();
  }
}

export type BacktestDetailJson = {
  logs: string[];
  notifications: string[];
  balanceSeries: BacktestPoint[];
  peak: BacktestPoint;
  trough: BacktestPoint;
  maxDrawdownAt: BacktestPoint;
  stopped: boolean;
  stopReason: string;
  stopMarkers: StopMarker[];
};

export const DEFAULT_BACKTEST_SCRIPT = `var config = {
  baseBet: { value: 100, type: 'balance', label: 'Base bet' },
  payout: { value: 2, type: 'multiplier', label: 'Cash out' }
};

engine.on('GAME_STARTING', function () {
  // Balance is allowed to go negative — the backtest runs the full history.
  engine.bet(config.baseBet.value, config.payout.value);
});

engine.on('GAME_ENDED', function () {
  var game = engine.history.first();
  log('#' + game.id, game.bust + 'x', game.cashedAt ? 'win' : 'loss', 'balance', userInfo.balance);
});`;

export function bitsToSats(bits: number): number {
  return Math.round(bits * 100);
}

export function satsToBits(sats: number): number {
  return sats / 100;
}

export function formatBits(sats: number): string {
  return satsToBits(sats).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
}

function point(gameId: number, balance: number, startingBalance: number): BacktestPoint {
  return { gameId, balance, profit: balance - startingBalance };
}

export type FullBalanceSeries = {
  startGameId: number;
  /** Per-game offset from startGameId (handles gaps in cached game ids). */
  offsets: Uint32Array;
  /** Balance in satoshis after each game, same length as offsets. */
  balances: Float64Array;
};

const SERIES_VERSION = 1;
const SERIES_HEADER_BYTES = 4 + 4 + 4 + 8; // id u32, version u32, count u32, startGameId f64

/**
 * Binary layout (little-endian): u32 backtest id, u32 version, u32 count,
 * f64 startGameId, then count × u32 game-id offsets, count × f64 balances.
 * The id prefix is consumed by the Rust save_backtest_series command; the
 * rest is stored verbatim and round-trips through deserializeFullSeries.
 */
export function serializeFullSeries(
  backtestId: number,
  startGameId: number,
  offsets: ArrayLike<number>,
  balances: ArrayLike<number>,
): Uint8Array {
  const count = offsets.length;
  const buf = new ArrayBuffer(SERIES_HEADER_BYTES + count * (4 + 8));
  const view = new DataView(buf);
  view.setUint32(0, backtestId, true);
  view.setUint32(4, SERIES_VERSION, true);
  view.setUint32(8, count, true);
  view.setFloat64(12, startGameId, true);
  let at = SERIES_HEADER_BYTES;
  for (let i = 0; i < count; i++, at += 4) view.setUint32(at, offsets[i], true);
  for (let i = 0; i < count; i++, at += 8) view.setFloat64(at, balances[i], true);
  return new Uint8Array(buf);
}

/** Parse a blob from load_backtest_series (which strips the 4-byte id prefix). */
export function deserializeFullSeries(buf: ArrayBuffer): FullBalanceSeries | null {
  const headerBytes = SERIES_HEADER_BYTES - 4; // stored blob has no id prefix
  if (buf.byteLength < headerBytes) return null;
  const view = new DataView(buf);
  const version = view.getUint32(0, true);
  const count = view.getUint32(4, true);
  if (version !== SERIES_VERSION || buf.byteLength < headerBytes + count * (4 + 8)) return null;
  const startGameId = view.getFloat64(8, true);
  const offsets = new Uint32Array(count);
  const balances = new Float64Array(count);
  let at = headerBytes;
  for (let i = 0; i < count; i++, at += 4) offsets[i] = view.getUint32(at, true);
  for (let i = 0; i < count; i++, at += 8) balances[i] = view.getFloat64(at, true);
  return { startGameId, offsets, balances };
}

export function parseBacktestDetail(resultJson: string): BacktestDetailJson {
  const parsed = JSON.parse(resultJson) as Partial<BacktestDetailJson>;
  return {
    logs: parsed.logs ?? [],
    notifications: parsed.notifications ?? [],
    balanceSeries: parsed.balanceSeries ?? [],
    peak: parsed.peak ?? { gameId: 0, balance: 0, profit: 0 },
    trough: parsed.trough ?? { gameId: 0, balance: 0, profit: 0 },
    maxDrawdownAt: parsed.maxDrawdownAt ?? { gameId: 0, balance: 0, profit: 0 },
    stopped: parsed.stopped ?? false,
    stopReason: parsed.stopReason ?? "",
    stopMarkers: parsed.stopMarkers ?? [],
  };
}

export class AutobetBacktestRunner {
  private logs: string[] = [];
  private notifications: string[] = [];
  private balanceSeries: BacktestPoint[] = [];
  private history = new HistoryBuffer();
  private engineEvents = new Emitter();
  private userEvents = new Emitter();
  private balance: number;
  private wagered = 0;
  private bets = 0;
  private wins = 0;
  private losses = 0;
  private queuedBet: Bet | null = null;
  private currentBet: Bet | null = null;
  private stopped = false;
  private stopReason = "";
  private stopMarkers: StopMarker[] = [];
  private lastStopGameIndex = Number.NEGATIVE_INFINITY;
  // Full-resolution balance history (one entry per game), persisted separately
  // as a binary blob so the chart can re-decimate on zoom. The sampled
  // balanceSeries in the result JSON stays as a fallback for old backtests.
  private fullOffsets: number[] = [];
  private fullBalances: number[] = [];
  private startGameId = 0;
  private endGameId = 0;
  private games = 0;
  private peak: BacktestPoint;
  private trough: BacktestPoint;
  private maxDrawdownAt: BacktestPoint;
  private maxDrawdown = 0;
  private cashOuts: Array<{ uname: string; wager: number; cashedAt: number }> = [];
  private gameState: "GAME_STARTING" | "GAME_STARTED" | "GAME_ENDED" = "GAME_STARTED";
  private balanceSampleEvery = 1;
  private readonly createdAt = new Date().toISOString();

  constructor(
    private readonly name: string,
    private readonly script: string,
    private readonly startingBalance: number,
  ) {
    this.balance = Math.max(0, Math.floor(startingBalance));
    this.peak = point(0, this.balance, this.startingBalance);
    this.trough = this.peak;
    this.maxDrawdownAt = this.peak;
    const runner = this;

    const userInfo = {
      get balance() {
        return runner.balance;
      },
      get bets() {
        return runner.bets;
      },
      get wagered() {
        return runner.wagered;
      },
      get profit() {
        return runner.balance - runner.startingBalance;
      },
      on: (event: string, listener: Listener) => this.userEvents.on(event, listener),
      once: (event: string, listener: Listener) => this.userEvents.once(event, listener),
      removeListener: (event: string, listener: Listener) =>
        this.userEvents.removeListener(event, listener),
      off: (event: string, listener: Listener) => this.userEvents.off(event, listener),
    };

    const engine = {
      history: this.history,
      playing: new Map<string, number>(),
      get cashOuts() {
        return runner.cashOuts;
      },
      get gameState() {
        return runner.gameState;
      },
      on: (event: string, listener: Listener) => this.engineEvents.on(event, listener),
      once: (event: string, listener: Listener) => this.engineEvents.once(event, listener),
      removeListener: (event: string, listener: Listener) =>
        this.engineEvents.removeListener(event, listener),
      off: (event: string, listener: Listener) => this.engineEvents.off(event, listener),
      bet: (wager: number, payout: number) => {
        // Like real bustabit: wagers are whole bits (multiples of 100 satoshis)
        // and payout targets are quantized to 0.01× steps, min 1.01×.
        const cleanWager = Math.round(Number(wager));
        const payoutCenti = Math.round(Number(payout) * 100);
        if (!Number.isFinite(cleanWager) || cleanWager <= 0 || cleanWager % 100 !== 0) {
          throw new Error(
            "engine.bet wager must be a positive multiple of 100 satoshis (whole bits).",
          );
        }
        if (!Number.isFinite(payoutCenti) || payoutCenti < 101) {
          throw new Error("engine.bet payout must be at least 1.01.");
        }
        if (this.queuedBet) throw new Error("A bet is already queued for the next game.");
        // Balance is allowed to go negative — the backtest models a hypothetical
        // where every bet is always placed and the run covers the full history.
        this.balance -= cleanWager;
        this.wagered += cleanWager;
        this.queuedBet = { wager: cleanWager, payoutCenti };
        this.userEvents.emit("BALANCE_CHANGED");
        return true;
      },
      getState: () => ({
        balance: this.balance,
        queuedBet: this.queuedBet,
        currentBet: this.currentBet,
        stopped: this.stopped,
        history: this.history.toArray(),
      }),
      getCurrentBet: () => this.currentBet,
      isBetQueued: () => this.queuedBet != null,
      cancelQueuedBet: () => {
        if (!this.queuedBet) return false;
        this.balance += this.queuedBet.wager;
        this.wagered -= this.queuedBet.wager;
        this.queuedBet = null;
        this.userEvents.emit("BALANCE_CHANGED");
        return true;
      },
      cashOut: () => false,
    };

    const log = (...values: unknown[]) => {
      if (this.logs.length >= 500) return;
      this.logs.push(values.map((value) => String(value)).join(" "));
    };
    const notify = (message: unknown) => {
      if (this.notifications.length < 100) this.notifications.push(String(message));
      log("notify:", message);
    };
    // The backtest always runs the entire cached history. stop() doesn't halt
    // the run — it records a marker (shown as a dashed vertical line on the
    // equity chart) at the game where the strategy would have stopped.
    const stop = (reason?: unknown) => {
      const message = reason == null ? "Script stopped." : String(reason);
      if (!this.stopped) {
        this.stopped = true;
        this.stopReason = message;
      }
      // A real script halts at the first stop(), so a backtested strategy often
      // re-triggers it every game after that. Only mark the start of each
      // contiguous stop streak — that's where the strategy would have halted.
      if (this.games > 0) {
        if (this.games > this.lastStopGameIndex + 1 && this.stopMarkers.length < 100) {
          this.stopMarkers.push({ gameId: this.endGameId, reason: message });
        }
        this.lastStopGameIndex = this.games;
      }
      log("stop (run continues):", message);
    };

    const fn = new Function(
      "engine",
      "userInfo",
      "chat",
      "log",
      "notify",
      "stop",
      `"use strict";
const window = undefined;
const document = undefined;
const fetch = undefined;
const setTimeout = undefined;
const setInterval = undefined;
var onGameStarted;
${script}
//# sourceURL=autobet-backtest.js`,
    );
    fn(engine, userInfo, { channels: new Map() }, log, notify, stop);
  }

  process(games: BacktestGame[]) {
    for (const game of games) {
      this.processGame(game);
    }
  }

  /** Binary blob (id-prefixed) for the save_backtest_series command. */
  fullSeriesBytes(backtestId: number): Uint8Array {
    return serializeFullSeries(backtestId, this.startGameId, this.fullOffsets, this.fullBalances);
  }

  isStopped() {
    return this.stopped;
  }

  result(): BacktestResult {
    if (this.games === 0) throw new Error("No cached games are available to backtest.");
    // A bet queued for a game that was never played (e.g. queued from the last
    // GAME_ENDED handler) is refunded so it doesn't skew balance or wagered.
    if (this.queuedBet) {
      this.balance += this.queuedBet.wager;
      this.wagered -= this.queuedBet.wager;
      this.queuedBet = null;
      this.fullBalances[this.fullBalances.length - 1] = this.balance;
    }
    this.recordBalancePoint(point(this.endGameId, this.balance, this.startingBalance), true);
    const detail: BacktestDetailJson = {
      logs: this.logs,
      notifications: this.notifications,
      balanceSeries: this.balanceSeries,
      peak: this.peak,
      trough: this.trough,
      maxDrawdownAt: this.maxDrawdownAt,
      stopped: this.stopped,
      stopReason: this.stopReason,
      stopMarkers: this.stopMarkers,
    };
    return {
      name: this.name,
      script: this.script,
      startingBalance: this.startingBalance,
      startGameId: this.startGameId,
      endGameId: this.endGameId,
      games: this.games,
      finalBalance: this.balance,
      profit: this.balance - this.startingBalance,
      wagered: this.wagered,
      bets: this.bets,
      wins: this.wins,
      losses: this.losses,
      maxDrawdown: this.maxDrawdown,
      createdAt: this.createdAt,
      resultJson: JSON.stringify(detail),
    };
  }

  private processGame(game: BacktestGame) {
    if (this.games === 0) {
      this.startGameId = game.gameId;
      const initialGameId = game.gameId > 0 ? game.gameId - 1 : game.gameId;
      const initialPoint = point(initialGameId, this.balance, this.startingBalance);
      this.peak = initialPoint;
      this.trough = initialPoint;
      this.maxDrawdownAt = initialPoint;
      this.recordBalancePoint(initialPoint, true);
    }
    this.endGameId = game.gameId;
    this.games += 1;

    this.currentBet = null;
    this.cashOuts = [];
    this.gameState = "GAME_STARTING";
    this.engineEvents.emit("GAME_STARTING");

    this.currentBet = this.queuedBet as Bet | null;
    this.queuedBet = null;
    const activeBet = this.currentBet;
    this.gameState = "GAME_STARTED";
    this.engineEvents.emit("GAME_STARTED");

    let cashedAt: number | null = null;
    let wager: number | null = null;
    if (activeBet) {
      this.bets += 1;
      wager = activeBet.wager;
      // Settle in integer hundredths so float noise in the bust value or a
      // script-computed payout can't flip a win into a loss or drop satoshis.
      const bustCenti = Math.round(game.bust * 100);
      if (bustCenti >= activeBet.payoutCenti) {
        cashedAt = activeBet.payoutCenti / 100;
        // wager is a multiple of 100, so this is an exact integer satoshi amount.
        this.balance += (activeBet.wager / 100) * activeBet.payoutCenti;
        this.wins += 1;
        this.cashOuts = [{ uname: "backtest", wager: activeBet.wager, cashedAt }];
      } else {
        this.losses += 1;
      }
      this.userEvents.emit("BALANCE_CHANGED");
    }

    this.history.push({
      ...game,
      id: game.gameId,
      wager,
      cashedAt,
    });

    this.fullOffsets.push(game.gameId - this.startGameId);
    this.fullBalances.push(this.balance);

    const p = point(game.gameId, this.balance, this.startingBalance);
    if (p.balance > this.peak.balance) this.peak = p;
    if (p.balance < this.trough.balance) this.trough = p;
    const drawdown = this.peak.balance - this.balance;
    if (drawdown > this.maxDrawdown) {
      this.maxDrawdown = drawdown;
      this.maxDrawdownAt = p;
    }
    this.recordBalancePoint(p);

    this.gameState = "GAME_ENDED";
    this.engineEvents.emit("GAME_ENDED");
    this.currentBet = null;
  }

  private recordBalancePoint(p: BacktestPoint, force = false) {
    const last = this.balanceSeries[this.balanceSeries.length - 1];
    if (last?.gameId === p.gameId) {
      this.balanceSeries[this.balanceSeries.length - 1] = p;
      return;
    }

    const gameOffset = Math.max(0, this.games - 1);
    if (force || gameOffset % this.balanceSampleEvery === 0) {
      this.balanceSeries.push(p);
      this.compactBalanceSeries();
    }
  }

  private compactBalanceSeries() {
    while (this.balanceSeries.length > MAX_BALANCE_SERIES_POINTS) {
      this.balanceSampleEvery *= 2;
      const first = this.balanceSeries[0];
      const last = this.balanceSeries[this.balanceSeries.length - 1];
      this.balanceSeries = this.balanceSeries.filter(
        (p) =>
          p === first ||
          p === last ||
          (p.gameId >= this.startGameId &&
            (p.gameId - this.startGameId) % this.balanceSampleEvery === 0),
      );
    }
  }
}
