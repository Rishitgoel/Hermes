# Hermes handover

The Hermes handover documentation lives with the backend module, since most of it is
cross-cutting (flows span backend + frontend):

➡ **[../../../backend/src/hermes/docs/handover/00-START-HERE.md](../../../backend/src/hermes/docs/handover/00-START-HERE.md)**

Frontend-specific notes worth knowing up front:

- Hermes' pages are mounted under a **`/hermes` URL prefix** in this app (the standalone
  sandbox serves them at the root). Any routing, navigation, or API-URL code is adapted for
  that prefix — see
  [04-admin-panel-integration.md](../../../backend/src/hermes/docs/handover/04-admin-panel-integration.md#4-mount--url-prefix).
- The SPA gates navigation on the user's computed admin scope returned at login, but that's
  a UI convenience only — the backend re-checks authorization on every mutating call. See
  [03-auth-and-roles-flow.md](../../../backend/src/hermes/docs/handover/03-auth-and-roles-flow.md).
