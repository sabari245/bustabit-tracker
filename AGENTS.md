# bustabit-tracker

Tauri 2 desktop app. Frontend: React 19 + TypeScript + Vite. Backend: Rust (`src-tauri/`).

Run dev: `bun run tauri dev`.

## Notes
- `docs/` holds research/reference material (not app code). See `docs/bustabit-provably-fair.html` — bustabit provably-fair hash-chain + crash-point algorithm notes, written dense for LLM use.

## UI / frontend rules
- UI uses **shadcn/ui** (Tailwind v4, style `radix-rhea`, olive base, lucide icons). Config in `components.json`.
- ALWAYS build UI from shadcn components. Add them via `bunx --bun shadcn@latest add <component>`.
- NEVER re-style or override shadcn components — use their original/default styling as-is.
- NEVER hand-roll a custom component. If a needed component isn't installed, look up the correct shadcn component online for that use case, then add and use it.

## Working style
- Don't change code unless asked; when researching/diagnosing, report findings first.
- Verify feasibility manually before building (e.g. confirmed bustabit.com/play is a JS SPA behind Cloudflare — raw HTTP scraping can't read its rendered DOM).
