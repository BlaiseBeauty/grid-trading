import { create } from 'zustand';

const usePlatformStore = create((set, get) => ({

  // ── Active system ──────────────────────────────────────────────────────
  // 'grid' | 'compass' | 'oracle' | 'platform'
  activeSystem: 'grid',
  setActiveSystem: (system) => set({ activeSystem: system }),

  // ── Bus events (ring buffer, max 50) ──────────────────────────────────
  busEvents: [],
  addBusEvent: (event) => set(state => ({
    busEvents: [event, ...state.busEvents].slice(0, 50),
  })),
  clearBusEvents: () => set({ busEvents: [] }),

  // ── Notification drawer ───────────────────────────────────────────────
  drawerOpen: false,
  setDrawerOpen: (open) => set({ drawerOpen: open }),
  toggleDrawer: () => set(state => ({ drawerOpen: !state.drawerOpen })),

  // ── Unread count (resets when drawer opens) ───────────────────────────
  unreadCount: 0,
  incrementUnread: () => set(state => ({ unreadCount: state.unreadCount + 1 })),
  clearUnread: () => set({ unreadCount: 0 }),

  // ── Platform health (from /api/platform/health) ───────────────────────
  platformHealth: null,
  setPlatformHealth: (health) => set({ platformHealth: health }),
  lastHealthFetch: null,
  setLastHealthFetch: (ts) => set({ lastHealthFetch: ts }),

  // ── ORACLE strip data (for God View) ─────────────────────────────────
  oracleTheses: [],
  setOracleTheses: (theses) => set({ oracleTheses: theses }),

  oracleRegime: null,
  setOracleRegime: (regime) => set({ oracleRegime: regime }),

  // ── COMPASS strip data (for God View) ────────────────────────────────
  compassPortfolio: null,
  setCompassPortfolio: (portfolio) => set({ compassPortfolio: portfolio }),

  compassRisk: null,
  setCompassRisk: (risk) => set({ compassRisk: risk }),

  // ── Platform costs (for header badge) ────────────────────────────────
  monthlyCostUsd: null,
  setMonthlyCostUsd: (cost) => set({ monthlyCostUsd: cost }),

  // ── Bus event type that should trigger unread increment ───────────────
  shouldNotify: (eventType) => {
    const notifyTypes = [
      'trade_closed', 'scram_triggered', 'thesis_created',
      'thesis_conviction_updated', 'performance_digest',
      'allocation_guidance',
    ];
    return notifyTypes.includes(eventType);
  },
}));

export default usePlatformStore;
