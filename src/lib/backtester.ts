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
  payout: number;
};

type HistoryGame = BacktestGame & {
  id: number;
  wager: number | null;
  cashedAt: number | null;
};

type Listener = (...args: unknown[]) => void;

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
};

export const DEFAULT_BACKTEST_SCRIPT = `var config = {
  baseBet: { value: 100, type: 'balance', label: 'Base bet' },
  payout: { value: 2, type: 'multiplier', label: 'Cash out' }
};

engine.on('GAME_STARTING', function () {
  if (userInfo.balance < config.baseBet.value) {
    stop('Insufficient balance');
    return;
  }

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
  private startGameId = 0;
  private endGameId = 0;
  private games = 0;
  private peak: BacktestPoint;
  private trough: BacktestPoint;
  private maxDrawdownAt: BacktestPoint;
  private maxDrawdown = 0;
  private cashOuts: Array<{ uname: string; wager: number; cashedAt: number }> = [];
  private gameState: "GAME_STARTING" | "GAME_STARTED" | "GAME_ENDED" = "GAME_STARTED";
  private readonly sampleEvery: number;
  private readonly createdAt = new Date().toISOString();

  constructor(
    private readonly name: string,
    private readonly script: string,
    private readonly startingBalance: number,
    totalGames: number,
  ) {
    this.balance = Math.max(0, Math.floor(startingBalance));
    this.sampleEvery = Math.max(1, Math.ceil(totalGames / 2400));
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
        const cleanWager = Math.floor(Number(wager));
        const cleanPayout = Number(payout);
        if (!Number.isFinite(cleanWager) || cleanWager <= 0) {
          throw new Error("engine.bet wager must be a positive integer.");
        }
        if (!Number.isFinite(cleanPayout) || cleanPayout <= 1) {
          throw new Error("engine.bet payout must be greater than 1.");
        }
        if (this.queuedBet) throw new Error("A bet is already queued for the next game.");
        if (cleanWager > this.balance) {
          this.stopped = true;
          this.stopReason = `Insufficient balance to bet ${cleanWager / 100} bits`;
          if (this.logs.length < 500) {
            this.logs.push(`stop: ${this.stopReason}`);
          }
          return false;
        }
        this.balance -= cleanWager;
        this.wagered += cleanWager;
        this.queuedBet = { wager: cleanWager, payout: cleanPayout };
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
    const stop = (reason?: unknown) => {
      this.stopped = true;
      this.stopReason = reason == null ? "Script stopped." : String(reason);
      log("stop:", this.stopReason);
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
      if (this.stopped) break;
      this.processGame(game);
    }
  }

  isStopped() {
    return this.stopped;
  }

  result(): BacktestResult {
    if (this.games === 0) throw new Error("No cached games are available to backtest.");
    const last = this.balanceSeries[this.balanceSeries.length - 1];
    if (!last || last.gameId !== this.endGameId) {
      this.balanceSeries.push(point(this.endGameId, this.balance, this.startingBalance));
    }
    const detail: BacktestDetailJson = {
      logs: this.logs,
      notifications: this.notifications,
      balanceSeries: this.balanceSeries,
      peak: this.peak,
      trough: this.trough,
      maxDrawdownAt: this.maxDrawdownAt,
      stopped: this.stopped,
      stopReason: this.stopReason,
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
    if (this.games === 0) this.startGameId = game.gameId;
    this.endGameId = game.gameId;
    this.games += 1;

    this.currentBet = null;
    this.cashOuts = [];
    this.gameState = "GAME_STARTING";
    this.engineEvents.emit("GAME_STARTING");
    if (this.stopped) return;

    this.gameState = "GAME_STARTED";
    this.engineEvents.emit("GAME_STARTED");
    this.currentBet = this.queuedBet as Bet | null;
    this.queuedBet = null;
    const activeBet = this.currentBet;

    let cashedAt: number | null = null;
    let wager: number | null = null;
    if (activeBet) {
      this.bets += 1;
      wager = activeBet.wager;
      if (game.bust >= activeBet.payout) {
        cashedAt = activeBet.payout;
        this.balance += Math.floor(activeBet.wager * activeBet.payout);
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

    const p = point(game.gameId, this.balance, this.startingBalance);
    if (p.balance > this.peak.balance) this.peak = p;
    if (p.balance < this.trough.balance) this.trough = p;
    const drawdown = this.peak.balance - this.balance;
    if (drawdown > this.maxDrawdown) {
      this.maxDrawdown = drawdown;
      this.maxDrawdownAt = p;
    }
    if (this.games === 1 || this.games % this.sampleEvery === 0) {
      this.balanceSeries.push(p);
    }

    this.gameState = "GAME_ENDED";
    this.engineEvents.emit("GAME_ENDED");
    this.currentBet = null;
  }
}
