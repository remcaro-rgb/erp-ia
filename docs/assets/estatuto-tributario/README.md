# Estatuto Tributario (Colombia), vectorized text

- `estatuto_tributario_vectorizado.txt`: full Estatuto Tributario as plain text prepared for retrieval (1.3 MB, 1,105 `[ARTICULO: n]` blocks, current as of October 2026). Structure markers: `[METADATA: LIBRO|TITULO|TEMA ...]` lines give the hierarchy, `[ARTICULO: n]` opens each article, followed by its title and text (including notes of later changes).
- Added 2026-11-03 by the owner. Reference only; not loaded by any code yet.
- **Use**: knowledge source for the AI assistant (design §7), to answer and explain Colombian tax questions with the article cited.
- **Hand-off notes for the assistant task**: see `docs/roadmap.md`, Cross-phase tracks, "AI knowledge base".
