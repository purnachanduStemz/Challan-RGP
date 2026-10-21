---
schema: clarification-answers/v1
status: submitted
generated_at: "2026-10-09T02:46:06.031Z"
scope: [frontend, generic]
questions_file: clarification-questions.json
---

# Rearchitecture Clarification Answers

## 🖥️ Frontend

- **F1** Which React version should the rewritten frontend target?
  - answer: React 18
  - source: user
- **F2** Which component or UI library should the React frontend use while preserving the existing appearance?
  - answer: Existing CSS and native React components
  - source: user
- **F3** Which visual references must be treated as authoritative for pixel-level parity?
  - answer: Project-root attachments: Screenshot (29).png, Screenshot (30).png, Screenshot (31).png, Screenshot (32).png, and image (2).png; also inspect the current frontend pages at frontend/*.html
  - source: user
- **F4** What design system or visual rule should govern the rewrite?
  - answer: Match existing pixel-by-pixel using extracted CSS custom properties and current assets
  - source: user
- **F5** Which accessibility standard should the React rewrite target without changing the user experience?
  - answer: WCAG 2.1 AA
  - source: user
- **F6** Which browser and runtime targets must remain supported?
  - answer: Same browsers as current frontend
  - source: user
- **F7** How should responsive behavior be handled during the rewrite?
  - answer: Preserve current layout and breakpoints exactly
  - source: user
- **F8** Which locales should remain in scope?
  - answer: preserve current locales; keep existing i18n library if present
  - source: default applied
- **F9** Which client-side state management approach should the React rewrite use?
  - answer: Preserve existing pattern; use React state/context unless a shared store is required
  - source: user
- **F10** How should existing frontend URLs and navigation be represented in React?
  - answer: use the de-facto router for the chosen target framework
  - source: user

## 📋 General

- **G1** What outcome defines a successful migration?
  - answer: All existing user-facing behavior and visuals preserved, with frontend tests and build passing
  - source: user
- **G2** What must not be changed as part of this frontend rewrite?
  - answer: Backend code, database schema, API contracts, authentication rules, business rules, and user-visible behavior are out of scope for changes
  - source: user
- **G3** What is the required policy for existing tests during the migration?
  - answer: must pass
  - source: user
- **G4** Where should the rewritten React frontend be created?
  - answer: new sibling directory: frontend-new
  - source: user
- **G5** Are there any additional requirements, exclusions, dependencies, compliance rules, or operational constraints?
  - answer: None beyond preserving the existing frontend behavior, visuals, API calls, authentication, routes, assets, and backend unchanged.
  - source: user
