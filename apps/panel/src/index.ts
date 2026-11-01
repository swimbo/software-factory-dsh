/**
 * `@factory/panel` — the read-only status surface.
 *
 * Public surface, in the order an operator meets it:
 *  - `createPanelServer()` — `GET /` and `GET /api/status`, loopback + token.
 *  - `buildStatus()` — the `status.v1` projection over a `Store` (no rendering).
 *  - `renderStatusPage()` — that projection as HTML, and the refusal pages.
 *  - `resolvePanelToken()` — where the token comes from, `0600` on first start.
 *  - `probeDshVersion()` — the one fact the store cannot hold: the DSH the workers run.
 *  - the design tokens, so a later UI change has one place to argue with.
 *
 * The panel is read-only in the only sense that matters: it holds a `Store`, it
 * calls read methods, and it has no route, no argument and no environment
 * variable that can write.
 */
export { createPanelServer } from './server.ts';
export type { PanelListener, PanelServer, PanelServerOptions } from './server.ts';

export {
  DEFAULT_PER_DAY_USD,
  DEFAULT_PER_UNIT_USD,
  FACTORY_VERSION,
  NO_RECEIPT_ID,
  PRICE_TABLE_VERSION,
  RECENT_VERDICT_LIMIT,
  STALE_LAUNCH_SECONDS,
  STATUS_SCHEMA_VERSION,
  buildStatus,
  describeUnknown,
  formatUsd,
  panelUnitState,
} from './status.ts';
export type { BuildStatusContext } from './status.ts';

export {
  renderNotFoundHtml,
  renderRefusalHtml,
  renderStatusPage,
  renderUnauthorizedHtml,
  escapeHtml,
} from './render.ts';

export { DSH_BIN_ENV, PROBE_TIMEOUT_MS, parseDshVersion, probeDshVersion } from './dsh-version.ts';
export type { ProbeOptions } from './dsh-version.ts';

export {
  TOKEN_ENV,
  TOKEN_FILE_ENV,
  generateToken,
  resolvePanelToken,
  tokenFilePath,
} from './token.ts';
export type { TokenResolution, TokenSource } from './token.ts';

export {
  CONTRAST_PAIRS,
  DARK,
  FONTS,
  LIGHT,
  SPACING,
  TOKEN_ROLES,
  TYPE,
  contrastRatio,
  paletteValue,
  relativeLuminance,
  stylesheet,
} from './tokens.ts';
export type {
  ContrastLevel,
  ContrastPair,
  Palette,
  TokenRole,
  TypeFamily,
  TypeSpec,
} from './tokens.ts';
